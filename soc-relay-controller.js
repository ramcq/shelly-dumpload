// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// SOC Relay Controller for Shelly 1PM Gen3 / 1 Mini Gen3
// Relay on above a high battery SOC threshold, off below a low one, gated on VE.Bus state,
// from the Victron Cerbo GX over MQTT.
//
// Two roles, resolved from the device ID at startup. See CONTROLS.md#shortage.
//   Dump load (.88 .90 .91 .100) - DHW immersions on a narrow SOC band. Ladder: inverter
//                                  overload, heat pump lock open, local input, lead relay
//                                  input (time switch), VE.Bus state, SOC + generation
//   Shortage lead (.209)         - relay open on shortage: SOC band 30-90%, or VE.Bus not
//                                  inverting

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000 // ms to wait before reconnection attempt
  },

  // Lead relay (has manual time switch connected to its input)
  leadRelay: {
    inputTopic: "shelly1pmg3-543204558fc8/status/input:0", // MQTT topic for lead relay input
    commandTopic: "shelly1pmg3-543204558fc8/command"       // where to ask it to republish
  },

  // Heat pump lock (.209): closed = heat pump running, open = shortage
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // Devices this script runs on, matched on device ID; an unlisted device does nothing.
  // `low` defaults to `high - 1`. `pollOffset` (ms) delays enabling after the lock closes
  // or the time switch turns on. See CONTROLS.md#dump-loads-together.
  relays: [
    { id: "543204558c6c", name: "DHW Left Top",     high: 96, pollOffset: 0 },
    { id: "543204558fc8", name: "DHW Left Bottom",  high: 94, leadRelay: true, pollOffset: 0 },
    { id: "dcda0ce04fb0", name: "DHW Right",        high: 95, pollOffset: 10 * 1000 },
    { id: "dcda0ce06e98", name: "DHW Annex",        high: 96, pollOffset: 20 * 1000 },
    { id: "d885ac0a3668", name: "HP Enable", shortageLead: true }
  ],

  // Shortage band, used by the shortage lead only. See CONTROLS.md#shortage.
  shortage: {
    lowSoc: 30,        // % - at or below: shortage
    highSoc: 90        // % - at or above: no shortage
  },

  // Inverter overload protection
  inverter: {
    emergencyLimit: 13000,  // W - fast-path emergency shutoff for inverter output
    heaterPower: 2700       // W - this heater's draw, for the headroom check before enabling
  },

  // Timing settings. No dwell timers: see CONTROLS.md#shortage.
  // MQTT.subscribe only takes effect after returning to the main loop, so the republish
  // request must come from a later timer.
  initialKeepaliveDelay: 1000,  // ms - after subscribing, before asking for a republish
  startupGrace: 5 * 60 * 1000,  // ms - wait for a first VE.Bus reading before acting on silence
  checkInterval: 30 * 1000,     // 30 seconds in milliseconds

  // Minimum generation (W) to enable a dump load, or to resolve .209's latch
  minGenerationPower: 500,

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    batterySOC: "system/0/Dc/Battery/Soc",
    acGeneration: "system/0/Ac/PvOnOutput/L1/Power",  // AC-coupled generation (solar + AC hydro) (W)
    dcGeneration: "dcsource/279/Dc/0/Power",           // DC-coupled hydro turbine power (W)
    vebusState: "vebus/276/State",                     // VE.Bus state (9=Inverting is the only active state for dump loads)
    inverterOutput: "vebus/276/Ac/Out/L1/P"            // VE.Bus inverter output power (W)
  },

  // Virtual component IDs (matches smart-load-controller.js for drop-in replacement)
  virtualComponents: {
    status: 204  // same as smart-load-controller VCOMP_STATUS
  },

  // Debug mode
  debugMode: true
};

// ===== State variables =====
let state = {
  // MQTT connection state
  mqttConnected: false,
  keepaliveTimer: null,
  reconnectTimer: null,

  // Device identity
  isLeadRelay: false,        // True if this device is the lead relay
  isShortageLead: false,     // True if this device owns the shortage decision
  leadRelayTopic: "",        // MQTT topic to monitor for lead relay input
  lockTopic: "",             // MQTT topic to monitor for the heat pump lock

  // Uptime in ms
  nowUptime: null,           // At the start of this pass; null until first read
  startedAtUptime: null,     // When this script started

  // Relay control state
  identityKnown: false,      // Whether this device knows which role it is running
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // Intended relay state (prevents re-entrancy)
  inputIsActive: false,      // State of the local input

  // Victron data
  currentSoc: 0,             // Current SOC from Victron
  acGeneration: 0,           // AC-coupled generation power (W)
  dcGeneration: 0,           // DC-coupled generation power (W)
  vebusState: 0,             // VE.Bus state (0=Off, 9=Inverting, etc.)
  shortageLatch: null,       // true, false, or null if not yet resolved
  vebusReceived: false,      // Whether a VE.Bus state has ever arrived; kept across a broker drop
  vebusStale: false,         // Set by a broker drop until VE.Bus is heard again
  inverterOutput: 0,         // VE.Bus inverter output power (W)

  // Lead relay state
  leadInputActive: false,    // State of the lead relay's input (manual time switch)
  leadInputReceived: false,  // Whether that state has been received

  // Heat pump lock, as published by .209; kept across a broker drop
  lockIsClosed: false,       // Closed = heat pump running, no shortage
  lockKnown: false,          // Whether the lock has been heard; if not, it is ignored

  // Control settings, from the relay table
  deviceName: "",
  highSocThreshold: 0,
  lowSocThreshold: 0,
  pollOffset: 0,             // Delay before enabling on a lock or time switch edge
  enableHeldUntilUptime: null,  // Uptime before which this relay may not enable
  edgeTimer: null,

  // Timer
  timerId: null
};

// ===== Elapsed time =====
// Intervals are measured against uptime, not Date.now(). See docs/adr/0003.
function refreshUptime() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || sys.uptime === undefined) {
    return;
  }

  state.nowUptime = sys.uptime * 1000;

  // Stamp the start on the first successful read
  if (state.startedAtUptime === null) {
    state.startedAtUptime = state.nowUptime;
  }
}

refreshUptime();

// True if `sinceUptime` is within the startup grace, or the clock is unknown
function withinGrace(sinceUptime) {
  if (state.nowUptime === null || sinceUptime === null) {
    return true;
  }

  return state.nowUptime - sinceUptime < config.startupGrace;
}

function withinStartupGrace() {
  return withinGrace(state.startedAtUptime);
}

// ===== Virtual component handles =====
let handles = {
  status: null
};

// ===== Helper functions =====
function logDebug(message) {
  if (config.debugMode) {
    console.log("[DEBUG-DUMP] " + message);
  }
}

function arrayContains(array, value) {
  for (let i = 0; i < array.length; i++) {
    if (array[i] === value) {
      return true;
    }
  }
  return false;
}

// Find this device in the relay table and take its settings
function applySettingsForDevice(deviceId) {
  for (let i = 0; i < config.relays.length; i++) {
    let relay = config.relays[i];

    if (deviceId.indexOf(relay.id) < 0) {
      continue;
    }

    state.deviceName = relay.name;
    state.isLeadRelay = relay.leadRelay === true;
    state.isShortageLead = relay.shortageLead === true;
    if (relay.high !== undefined) {
      state.highSocThreshold = relay.high;
      state.lowSocThreshold = relay.low !== undefined ? relay.low : relay.high - 1;
    }

    state.pollOffset = relay.pollOffset !== undefined ? relay.pollOffset : 0;

    return true;
  }

  return false;
}

// Shortage latch (shortage lead only): set at or below lowSoc, cleared at or above highSoc;
// if unresolved, generation clears it. See CONTROLS.md#shortage.
function updateShortageLatch() {
  if (!state.isShortageLead || state.currentSoc <= 0) {
    return;
  }

  if (state.currentSoc <= config.shortage.lowSoc) {
    state.shortageLatch = true;
  } else if (state.currentSoc >= config.shortage.highSoc) {
    state.shortageLatch = false;
  } else if (state.shortageLatch === null &&
             state.acGeneration + state.dcGeneration > config.minGenerationPower) {
    state.shortageLatch = false;
  }
}

// Shortage: VE.Bus not inverting, or the latch (unresolved counts as shortage).
// Null if there is no reading yet.
function inShortage() {
  if (!state.vebusReceived) {
    return withinStartupGrace() ? null : true;
  }

  if (state.vebusState !== 9) {
    return true;
  }

  if (state.currentSoc <= 0) {
    return null;
  }

  return state.shortageLatch !== false;
}

// Which reading is missing when inShortage() returns null
function unresolvedReason() {
  return state.vebusReceived ? "no SOC reading yet" : "nothing heard from the Cerbo yet";
}

// Which term is short, for the log and status
function shortageReason() {
  if (!state.vebusReceived || state.vebusState !== 9) {
    return "VE.Bus " + getVebusStateString(state.vebusState);
  }

  if (state.shortageLatch === null) {
    return "SOC " + state.currentSoc + "%, no generation seen yet";
  }

  if (state.currentSoc <= config.shortage.lowSoc) {
    return "SOC " + state.currentSoc + "%";
  }

  return "SOC " + state.currentSoc + "%, held until " + config.shortage.highSoc + "%";
}

function getVebusStateString(vebusState) {
  if (vebusState === 0) return "Off";
  if (vebusState === 1) return "Low Power";
  if (vebusState === 2) return "Fault";
  if (vebusState === 3) return "Bulk";
  if (vebusState === 4) return "Absorption";
  if (vebusState === 5) return "Float";
  if (vebusState === 6) return "Storage";
  if (vebusState === 7) return "Equalize";
  if (vebusState === 8) return "Passthru";
  if (vebusState === 9) return "Inverting";
  if (vebusState === 10) return "Power Assist";
  if (vebusState === 11) return "Power Supply";
  if (vebusState === 252) return "External Control";
  return "Unknown(" + vebusState + ")";
}

// Update the status display
function updateStatus(event) {
  let socPart = state.currentSoc > 0 ? state.currentSoc + "%" : "No SOC";
  let thresholdInfo = state.isShortageLead
    ? " [On:" + config.shortage.highSoc + "%, Off:" + config.shortage.lowSoc + "%]"
    : " [On:" + state.highSocThreshold + "%, Off:" + state.lowSocThreshold + "%]";

  let relayPart = state.deviceName + (state.relayIsOn ? " ON" : " OFF");
  let totalGen = state.acGeneration + state.dcGeneration;
  let genPart = ", Gen " + totalGen.toFixed(0) + "W";
  let inverterPart = state.inverterOutput > 0 ? ", Inv " + state.inverterOutput.toFixed(0) + "W" : "";

  let vebusPart = ", VE " + getVebusStateString(state.vebusState);
  let inputPart = ", Input " + (state.inputIsActive ? "ON" : "OFF");
  // Only on relays that follow the lead relay
  let leadPart = state.leadRelayTopic ? ", Lead " + (state.leadInputActive ? "ON" : "OFF") : "";

  let shortagePart = "";
  if (state.isShortageLead) {
    let shortage = inShortage();
    if (shortage === null) {
      shortagePart = ", " + unresolvedReason();
    } else if (shortage) {
      shortagePart = ", SHORTAGE: " + shortageReason();
    }
  } else if (state.lockKnown) {
    shortagePart = state.lockIsClosed ? ", HP Enabled" : ", HP Locked";
  }

  let eventPart = event ? ": " + event : "";

  let statusMessage = socPart + thresholdInfo + ", " + relayPart + genPart + inverterPart + vebusPart + inputPart + leadPart + shortagePart + eventPart;

  logDebug("Status: " + statusMessage);

  if (handles.status) {
    try {
      handles.status.setValue(statusMessage);
    } catch (e) {
      console.log("Error updating status: " + e.message);
    }
  }
}

// ===== Virtual component setup =====
function setupVirtualComponents(existingComponentKeys) {
  let compId = config.virtualComponents;

  // Status display
  if (!arrayContains(existingComponentKeys, "text:" + compId.status)) {
    console.log("Creating status component");
    Shelly.call("Virtual.Add", {
      type: "text",
      id: compId.status,
      config: {
        name: "Status",
        default_value: "",
        meta: {
          ui: {
            view: "label"
          }
        }
      }
    });
  } else {
    logDebug("Status component exists");
  }

  // Wait for components to initialize
  Timer.set(2000, false, function() {
    finishSetup();
  });
}

function finishSetup() {
  logDebug("Finishing setup");

  let compId = config.virtualComponents;

  // Get component handles
  try {
    handles.status = Virtual.getHandle("text:" + compId.status);
  } catch (e) {
    console.log("Error getting component handles: " + e.message);
  }

  // Set up event handlers
  setupEventHandlers();

  // Start MQTT connection
  connectMqtt();

  // Start monitoring loop
  startMonitoring();

  console.log("=== SOC Relay Controller Configuration ===");
  console.log("Device: " + state.deviceName +
             (state.isShortageLead ? " (determines shortage)" : " (dump load)") +
             (state.isLeadRelay ? ", lead relay" : ""));
  if (state.isShortageLead) {
    console.log("Shortage band: " + config.shortage.lowSoc + "% to " +
               config.shortage.highSoc + "%, settled by " +
               config.minGenerationPower + "W of generation when unresolved");
  } else {
    console.log("High SOC Threshold: " + state.highSocThreshold + "%");
    console.log("Low SOC Threshold: " + state.lowSocThreshold + "%");
  }
  if (!state.isShortageLead) {
    console.log("Emergency Inverter Limit: " + config.inverter.emergencyLimit + "W");
    console.log("Heater Power (headroom): " + config.inverter.heaterPower + "W");
    console.log("Minimum Generation: " + config.minGenerationPower + "W");
  }
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  if (state.leadRelayTopic) {
    console.log("Lead Relay Monitoring: " + state.leadRelayTopic);
  }
  if (state.lockTopic) {
    console.log("Heat Pump Lock Monitoring: " + state.lockTopic);
  }
  console.log("==========================================");

  updateStatus("Monitoring started");
}

// Dump loads other than the lead relay follow the time switch; all dump loads follow the lock
function assignFollowedTopics() {
  state.leadRelayTopic = (state.isShortageLead || state.isLeadRelay)
    ? ""
    : config.leadRelay.inputTopic;

  state.lockTopic = state.isShortageLead ? "" : config.heatPumpLock.statusTopic;
}

// Resolve this device's role. Returns false if it is not in the relay table.
function determineDeviceIdentity() {
  let info = Shelly.getDeviceInfo();

  logDebug("Device ID: " + info.id);

  if (!applySettingsForDevice(info.id)) {
    console.log("Device " + info.id + " is not in the relay table - doing nothing");
    return false;
  }

  assignFollowedTopics();
  state.identityKnown = true;

  if (state.isShortageLead) {
    console.log("This device determines shortage - " + state.deviceName);
  } else if (state.isLeadRelay) {
    console.log("This device IS the lead relay - will use local input");
  } else {
    console.log("This device is NOT the lead relay - will monitor: " + state.leadRelayTopic);
  }

  return true;
}

// ===== Event handlers =====
function setupEventHandlers() {
  logDebug("Setting up event handlers");

  // Watch for switch and input events
  Shelly.addEventHandler(function(event) {
    if (!event || !event.name || !event.info || !event.info.event)
      return;

    // Filter events: only process switch toggle and input toggle events
    let isRelevantEvent = false;
    if (event.name === "switch" && event.info.event === "toggle") {
      isRelevantEvent = true;
    } else if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      isRelevantEvent = true;
    }

    if (!isRelevantEvent) {
      // Skip power measurements, status updates, and other events
      return;
    }

    logDebug("Event received: " + JSON.stringify(event));

    if (event.name === "switch" && event.info.event === "toggle") {
      logDebug("Switch toggle event detected");

      // Get new state from event
      let newState = event.info.state;

      // Check if this matches our intended state (prevents re-entrancy)
      if (newState === state.intendedRelayOn) {
        // Expected change - just update actual state
        state.relayIsOn = newState;
        logDebug("Relay state changed as expected to: " + newState);
        return; // Don't call checkSystemState - this was our intended action
      } else {
        // Unexpected change (manual toggle or external control)
        state.relayIsOn = newState;
        state.intendedRelayOn = newState; // Sync intended with actual
        logDebug("Relay state changed externally to: " + newState);
        checkSystemState(); // Reconcile state
      }
    }

    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      logDebug("Input toggle event detected");

      // Get new state from event
      let newInputState = event.info.state;
      state.inputIsActive = newInputState;

      // If we're the lead relay, local input represents the manual time switch
      if (state.isLeadRelay) {
        state.leadInputActive = state.inputIsActive;
        console.log("Lead relay input " + (state.leadInputActive ? "activated" : "deactivated") + " (manual time switch)");
        logDebug("Lead input updated from local input: " + state.leadInputActive);
      }

      checkSystemState(); // Immediately check state
    }
  });
}

// ===== MQTT connection and message handling =====
function processMqttMessage(topic, message) {
  // Skip empty messages
  if (message.length === 0) {
    logDebug("Empty message for topic: " + topic);
    return;
  }

  try {
    // Handle lead relay input status (only if we're NOT the lead relay)
    if (!state.isLeadRelay && state.leadRelayTopic && topic === state.leadRelayTopic) {
      let payload = JSON.parse(message);
      if (payload.state !== undefined) {
        let wasActive = state.leadInputActive;
        state.leadInputActive = Boolean(payload.state);
        state.leadInputReceived = true;

        // Log to console on state change (this is a priority control signal)
        if (wasActive !== state.leadInputActive) {
          console.log("Lead relay input " + (state.leadInputActive ? "activated" : "deactivated") + " (manual time switch)");
        }

        logDebug("Lead input updated via MQTT: " + state.leadInputActive);
        updateStatus("Lead input changed");

        if (state.leadInputActive) {
          checkAfterOffset();
        } else {
          checkSystemState();
        }
      }
      return;
    }

    // Handle the heat pump lock
    if (state.lockTopic && topic === state.lockTopic) {
      let payload = JSON.parse(message);
      if (payload.output !== undefined) {
        let wasClosed = state.lockIsClosed;
        state.lockIsClosed = Boolean(payload.output);
        state.lockKnown = true;

        if (wasClosed !== state.lockIsClosed) {
          console.log("Heat pump lock " + (state.lockIsClosed ? "closed - no shortage" : "open - SHORTAGE"));
        }

        updateStatus("Heat pump lock changed");

        if (state.lockIsClosed) {
          checkAfterOffset();
        } else {
          checkSystemState();
        }
      }
      return;
    }

    // Handle Victron Cerbo GX messages
    let topicPrefix = "N/" + config.cerbo.portalId + "/";
    if (topic.indexOf(topicPrefix) !== 0)
      return;

    let relativeTopic = topic.substring(topicPrefix.length);
    let payload = JSON.parse(message);

    if (!payload.hasOwnProperty("value") || payload.value === null) {
      logDebug("Ignoring message with null value");
      return;
    }

    // Update battery SOC
    if (relativeTopic === config.topics.batterySOC) {
      state.currentSoc = parseFloat(payload.value);
    }

    // Update AC-coupled generation
    if (relativeTopic === config.topics.acGeneration) {
      state.acGeneration = parseFloat(payload.value);
    }

    // Update DC-coupled generation
    if (relativeTopic === config.topics.dcGeneration) {
      state.dcGeneration = parseFloat(payload.value);
    }

    // Update VE.Bus state
    if (relativeTopic === config.topics.vebusState) {
      let prevState = state.vebusState;
      state.vebusState = parseInt(payload.value);
      state.vebusReceived = true;
      state.vebusStale = false;
      // Log on state change
      if (prevState !== state.vebusState) {
        console.log("VE.Bus state: " + state.vebusState + " (" + getVebusStateString(state.vebusState) + ")");
      }
    }

    // Update inverter output - with fast-path emergency suppression
    if (relativeTopic === config.topics.inverterOutput) {
      state.inverterOutput = parseFloat(payload.value);

      // Fast-path emergency suppression if inverter output exceeds safe limit
      if (!state.isShortageLead &&
          state.inverterOutput > config.inverter.emergencyLimit && state.relayIsOn) {
        logDebug("EMERGENCY: Inverter output " + state.inverterOutput.toFixed(0) +
                "W exceeds " + config.inverter.emergencyLimit + "W limit - turning off");
        turnRelayOff("Inverter overload protection");
      }
    }

    updateShortageLatch();
  } catch (e) {
    console.log("Error processing MQTT message: " + e.message);
  }
}

function handleMqttConnected() {
  console.log("Connected to MQTT broker");
  state.mqttConnected = true;

  // Subscribe to Victron topics
  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.topics) {
    let topic = topicPrefix + config.topics[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  // Subscribe to lead relay input topic (only if we're NOT the lead relay)
  if (!state.isLeadRelay && state.leadRelayTopic) {
    MQTT.subscribe(state.leadRelayTopic, processMqttMessage);
    logDebug("Subscribed to lead relay: " + state.leadRelayTopic);
  }

  // Subscribe to the heat pump lock
  if (state.lockTopic) {
    MQTT.subscribe(state.lockTopic, processMqttMessage);
    logDebug("Subscribed to the heat pump lock: " + state.lockTopic);
  }

  // Ask for a republish once the subscriptions take effect
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
  });

  // Periodic keepalive (every 30 seconds). Victron publishes only on change, so keep asking
  // for a republish until the VE.Bus state has been seen.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.vebusReceived && !state.vebusStale);
    requestFollowedStatus(false);
  });
}

// Shelly publishes status only on change and unretained; `status_update` on the command
// topic asks for a republish. Ask until answered, and always on connect.
function requestFollowedStatus(force) {
  if (state.leadRelayTopic && (force || !state.leadInputReceived)) {
    askToRepublish(config.leadRelay.commandTopic, "the lead relay");
  }

  if (state.lockTopic && (force || !state.lockKnown)) {
    askToRepublish(config.heatPumpLock.commandTopic, "the heat pump lock");
  }
}

function askToRepublish(commandTopic, label) {
  MQTT.publish(commandTopic, "status_update", 1, false);
  logDebug("Asked " + label + " to republish: " + commandTopic);
}

function sendKeepalive(suppressRepublish) {
  if (!state.mqttConnected) {
    logDebug("Cannot send keepalive: not connected");
    return;
  }

  let keepaliveTopic = "R/" + config.cerbo.portalId + "/keepalive";
  let payload = "";

  if (suppressRepublish) {
    payload = JSON.stringify({
      "keepalive-options": ["suppress-republish"]
    });
  }

  MQTT.publish(keepaliveTopic, payload, 1, false);
  logDebug("Sent keepalive" + (suppressRepublish ? " (suppress-republish)" : ""));
}

function resetMqttData() {
  state.currentSoc = 0;
  state.acGeneration = 0;
  state.dcGeneration = 0;
  state.vebusState = 0;
  state.vebusStale = true;
  state.inverterOutput = 0;
  if (!state.isLeadRelay) {
    state.leadInputActive = false;
    state.leadInputReceived = false;
  }

  logDebug("Reset MQTT data due to disconnection");
}

function scheduleReconnect() {
  if (!state.reconnectTimer) {
    logDebug("Scheduling reconnect in " + (config.cerbo.reconnectDelay / 1000) + " seconds");
    state.reconnectTimer = Timer.set(config.cerbo.reconnectDelay, false, function() {
      state.reconnectTimer = null;
      connectMqtt();
    });
  }
}

// Bring the device's own MQTT config up to what this controller needs. Returns true if a
// reconfigure is under way, which ends in a reboot and so ends this script's run.
function ensureMqttConfig() {
  let mqttConfig = Shelly.getComponentConfig("mqtt");
  if (!mqttConfig) {
    logDebug("No MQTT config available");
    return false;
  }

  let needsConfig = false;

  if (!mqttConfig.enable) {
    needsConfig = true;
    logDebug("MQTT is disabled, enabling it");
  } else if (mqttConfig.server !== config.cerbo.host + ":" + config.cerbo.port) {
    needsConfig = true;
    logDebug("MQTT server doesn't match, reconfiguring");
  } else if (mqttConfig.status_ntf === false) {
    // Followers need status notifications. Firmware without the key leaves it undefined.
    needsConfig = true;
    logDebug("MQTT status notifications are off, reconfiguring");
  }

  if (!needsConfig) {
    return false;
  }

  Shelly.call("MQTT.SetConfig", {
    config: {
      enable: true,
      server: config.cerbo.host + ":" + config.cerbo.port,
      status_ntf: true
    }
  }, function(result, error_code, error_message) {
    if (error_code !== 0) {
      console.log("Error configuring MQTT: " + error_message);
      scheduleReconnect();
      return;
    }

    logDebug("MQTT configured, rebooting device...");
    Shelly.call("Shelly.Reboot", {});
  });

  return true;
}

function connectMqtt() {
  // Clear any pending reconnect timers
  if (state.reconnectTimer) {
    Timer.clear(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  // Set handlers even if already connected
  MQTT.setConnectHandler(handleMqttConnected);

  MQTT.setDisconnectHandler(function() {
    console.log("Disconnected from MQTT broker");
    state.mqttConnected = false;
    resetMqttData();

    if (state.keepaliveTimer) {
      Timer.clear(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }

    scheduleReconnect();
  });

  if (ensureMqttConfig()) {
    return; // reboot pending
  }

  let mqttStatus = Shelly.getComponentStatus("mqtt");
  if (mqttStatus && mqttStatus.connected === true) {
    logDebug("MQTT is already connected");
    if (!state.mqttConnected) {
      handleMqttConnected();
    }
    return;
  }

  if (state.mqttConnected) {
    logDebug("State discrepancy: internal state says connected but MQTT is disconnected");
    state.mqttConnected = false;
    resetMqttData();
  }

  logDebug("Waiting for MQTT connection to " + config.cerbo.host + ":" + config.cerbo.port);
}

// ===== Device state management =====
// Synchronously update relay and input state from device
function updateDeviceState() {
  // Get switch status
  let switchStatus = Shelly.getComponentStatus("switch:0");
  if (switchStatus && switchStatus.output !== undefined) {
    if (state.relayIsOn !== switchStatus.output) {
      state.relayIsOn = switchStatus.output;
      state.intendedRelayOn = switchStatus.output; // Sync intended with actual
      logDebug("Relay state synced: " + state.relayIsOn);
    }
  }

  // Get input status
  let inputStatus = Shelly.getComponentStatus("input:0");
  if (inputStatus && inputStatus.state !== undefined) {
    if (state.inputIsActive !== inputStatus.state) {
      state.inputIsActive = inputStatus.state;

      // If we're the lead relay, local input represents the manual time switch
      if (state.isLeadRelay) {
        state.leadInputActive = state.inputIsActive;
        logDebug("Lead input synced from local input: " + state.leadInputActive);
      }
    }
  }
}

// ===== Relay control logic =====
function turnRelayOn(reason) {
  logDebug("Attempting to turn relay ON: " + reason);

  // Set intended state before making RPC call
  state.intendedRelayOn = true;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay on: " + error_message);
        state.intendedRelayOn = state.relayIsOn; // Revert intended on error
        return;
      }

      state.relayIsOn = true;
      updateStatus(reason);
    }
  );
}

function turnRelayOff(reason) {
  logDebug("Attempting to turn relay OFF: " + reason);

  // Set intended state before making RPC call
  state.intendedRelayOn = false;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay off: " + error_message);
        state.intendedRelayOn = state.relayIsOn; // Revert intended on error
        return;
      }

      state.relayIsOn = false;
      updateStatus(reason);
    }
  );
}

// Hold enabling for this relay's pollOffset after a shared edge, then check again
function checkAfterOffset() {
  if (state.pollOffset <= 0) {
    checkSystemState();
    return;
  }

  refreshUptime();
  if (state.nowUptime !== null) {
    state.enableHeldUntilUptime = state.nowUptime + state.pollOffset;
  }

  if (state.edgeTimer) {
    Timer.clear(state.edgeTimer);
  }
  // +1 s, since uptime is in whole seconds
  state.edgeTimer = Timer.set(state.pollOffset + 1000, false, function() {
    state.edgeTimer = null;
    checkSystemState();
  });
}

// Check the stagger hold and inverter headroom before enabling
function canSafelyEnable() {
  if (state.enableHeldUntilUptime !== null && state.nowUptime !== null &&
      state.nowUptime < state.enableHeldUntilUptime) {
    logDebug("Waiting for this relay's offset before enabling");
    return false;
  }

  if (state.isShortageLead) {
    return true;
  }

  if (state.inverterOutput > 0 &&
      state.inverterOutput + config.inverter.heaterPower >= config.inverter.emergencyLimit) {
    logDebug("Inverter headroom insufficient: " + state.inverterOutput.toFixed(0) + "W + " +
            config.inverter.heaterPower + "W >= " + config.inverter.emergencyLimit + "W");
    updateStatus("Inverter limited");
    return false;
  }
  return true;
}

function checkSystemState() {
  refreshUptime();

  updateShortageLatch();
  updateStatus("Monitoring");

  // No action until the role is known
  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  // PRIORITY 0: Emergency inverter overload protection (overrides everything)
  // Belt-and-braces for the MQTT fast-path check in processMqttMessage
  if (!state.isShortageLead && state.inverterOutput > config.inverter.emergencyLimit) {
    if (state.relayIsOn) {
      turnRelayOff("Inverter overload: " + state.inverterOutput.toFixed(0) + "W");
    }
    return;
  }

  // PRIORITY 1: Shortage. On .209, the relay is open on shortage.
  // See CONTROLS.md#who-decides-and-how-the-decision-travels
  if (state.isShortageLead) {
    let shortage = inShortage();

    if (shortage === null) {
      logDebug("Shortage unresolved (" + unresolvedReason() + ") - no action");
      return;
    }

    if (shortage && state.relayIsOn) {
      turnRelayOff("SHORTAGE: " + shortageReason());
    } else if (!shortage && !state.relayIsOn) {
      turnRelayOn("Shortage over");
    }
    return;
  }

  // Dump loads: off while the lock is open, overriding the time switch. Ignored until heard.
  if (state.lockKnown && !state.lockIsClosed) {
    if (state.relayIsOn) {
      turnRelayOff("SHORTAGE: heat pump locked");
    }
    return;
  }

  // PRIORITY 2: Local input (for the lead relay, this is the manual time switch)
  // For non-lead relays, local input can still manually override
  if (state.inputIsActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Local input active" + (state.isLeadRelay ? " (manual time switch)" : ""));
    }
    return; // Skip other checks when local input is active
  }

  // PRIORITY 3: Lead relay input (manual time switch) - only for non-lead relays
  if (!state.isLeadRelay && state.leadInputActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Lead relay input active (manual time switch ON)");
    }
    return; // Skip other checks
  }

  // PRIORITY 4: VE.Bus state check
  // Only allow dump loads when VE.Bus is Inverting (state 9)
  // This covers: inverter off, inverter faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/PowerAssist)
  if (state.vebusState !== 9) {
    // No reading yet: wait out the startup grace
    if (!state.vebusReceived && withinStartupGrace()) {
      logDebug("No VE.Bus state yet, within startup grace - no action");
      return;
    }

    if (state.relayIsOn) {
      turnRelayOff("VE.Bus " + getVebusStateString(state.vebusState));
    } else {
      logDebug("VE.Bus not inverting (" + getVebusStateString(state.vebusState) + ") - no action");
    }
    return;
  }

  // PRIORITY 5: SOC-based control
  if (state.currentSoc <= 0) {
    logDebug("No SOC data available - no action taken");
    return;
  }

  let totalGeneration = state.acGeneration + state.dcGeneration;
  let sufficientGeneration = totalGeneration >= config.minGenerationPower;

  logDebug("SOC control: Current=" + state.currentSoc + "%, High=" + state.highSocThreshold +
          "%, Low=" + state.lowSocThreshold + "%, Gen=" + totalGeneration.toFixed(0) + "W" +
          " (need >=" + config.minGenerationPower + "W to enable)");

  if (state.currentSoc >= state.highSocThreshold && !state.relayIsOn &&
      sufficientGeneration && canSafelyEnable()) {
    turnRelayOn("SOC high + gen: " + state.currentSoc + "% >= " + state.highSocThreshold + "%, gen " + totalGeneration.toFixed(0) + "W");
  }
  else if (state.currentSoc <= state.lowSocThreshold && state.relayIsOn) {
    turnRelayOff("SOC low: " + state.currentSoc + "% <= " + state.lowSocThreshold + "%");
  }
}

function checkStatus() {
  // Synchronously update device state, then evaluate control logic
  updateDeviceState();
  checkSystemState();
}

function startMonitoring() {
  logDebug("Starting monitoring with interval: " + (config.checkInterval / 1000) + " seconds");

  // Clear existing timer if it exists
  if (state.timerId !== null) {
    Timer.clear(state.timerId);
    state.timerId = null;
    logDebug("Cleared existing timer");
  }

  checkStatus();

  state.timerId = Timer.set(config.checkInterval, true, function() {
    logDebug("Timer triggered check");
    checkStatus();
  });
}

// ===== Initialization =====
function initializeVirtualComponents() {
  logDebug("Initializing virtual components");

  let compId = config.virtualComponents;
  let keys = ["text:" + compId.status];

  Shelly.call(
    "Shelly.GetComponents",
    {
      keys: keys,
      include: ["config"]
    },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting components: " + error_message);
        finishSetup();
        return;
      }

      let existingComponentKeys = [];
      if (result && result.components && Array.isArray(result.components)) {
        logDebug("Found " + result.components.length + " existing components");
        for (let i = 0; i < result.components.length; i++) {
          if (result.components[i] && result.components[i].key) {
            existingComponentKeys.push(result.components[i].key);
          }
        }
      } else {
        logDebug("No existing components found");
      }

      setupVirtualComponents(existingComponentKeys);
    }
  );
}

function init() {
  console.log("SOC Relay Controller starting");

  // Initial state update
  updateDeviceState();

  // Identity first: everything else depends on the role
  if (!determineDeviceIdentity()) {
    return;
  }

  initializeVirtualComponents();
}

// Run initialization
init();
