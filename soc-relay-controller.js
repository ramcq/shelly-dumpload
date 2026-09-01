// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// SOC Relay Controller for Shelly 1PM Gen3 / 1 Mini Gen3
// Relay on above a high battery SOC threshold, off below a low one, gated on VE.Bus state,
// from the Victron Cerbo GX over MQTT. Also monitors a "lead" relay's input state (manual
// time switch) to coordinate multiple relays.
//
// Two roles, resolved from the device ID at startup. See CONTROLS.md.
//   Dump load (.88 .90 .91 .100) - DHW immersions on a narrow SOC band
//   Shortage lead (.209)         - determines shortage on a 60-point band. Not a dump load,
//                                  which is why this file is not named for one

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
    deviceId: "543204558fc8", // Device ID of the lead relay
    inputTopic: "shelly1pmg3-543204558fc8/status/input:0" // MQTT topic for lead relay input
  },

  // SOC control settings
  soc: {
    highThreshold: 95, // % - enable relay when SOC exceeds this value (configurable via UI)
    lowThreshold: null // % - null derives it as highThreshold - 1; a wide band must be
                       // stated outright
  },

  // Inverter overload protection
  inverter: {
    emergencyLimit: 13000,  // W - fast-path emergency shutoff for inverter output
    heaterPower: 2700       // W - this heater's draw, for the headroom check before enabling.
                            // 0 disables because the heat pump is an enable, not a direct load
  },

  // Timing settings. There are no dwell timers: SOC control does not chatter, and the
  // measured cycling rate is decades inside the relay's rating. See CONTROLS.md.
  initialKeepaliveDelay: 1000,  // ms - after subscribing, before asking for a republish
  identityRetryDelay: 5 * 1000, // ms - between attempts to read the device ID
  startupGrace: 3 * 60 * 1000,  // ms - how long the VE.Bus gate waits for its first reading
                                // before treating silence as trouble. Covers a Cerbo boot
  checkInterval: 30 * 1000,     // 30 seconds in milliseconds

  // Minimum generation required to enable dump loads (W)
  // Prevents enabling with no generation (e.g. post-outage, nighttime)
  // 0 disables the gate
  minGenerationPower: 500,

  // Whether the manual time switch reaches this relay, locally or via the lead relay
  followTimeSwitch: true,

  // Name of the virtual component group, so the role is visible in the device UI
  groupName: "Dump Load Controller",

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    batterySOC: "system/0/Dc/Battery/Soc",
    acGeneration: "system/0/Ac/PvOnOutput/L1/Power",  // AC-coupled generation (solar + AC hydro) (W)
    dcGeneration: "dcsource/279/Dc/0/Power",           // DC-coupled hydro turbine power (W)
    vebusState: "vebus/276/State",                     // VE.Bus state (9=Inverting is the only active state for dump loads)
    inverterOutput: "vebus/276/Ac/Out/L1/P"            // VE.Bus inverter output power (W)
  },

  // The shortage lead (.209) runs this file with different numbers and none of the dump
  // load gates. Its thresholds live here, in one deployment, and nowhere else.
  shortageLead: {
    deviceId: "d885ac0a3668", // .209 Heat Pump Enable
    name: "Heat Pump Enable",
    highThreshold: 90,        // % - leave shortage. Above what a generator run reaches
    lowThreshold: 30          // % - enter shortage. Ten points above generator autostart
  },

  // Virtual component IDs (matches smart-load-controller.js for drop-in replacement)
  virtualComponents: {
    highSocThreshold: 202,  // same as smart-load-controller VCOMP_HIGH_SOC
    status: 204,            // same as smart-load-controller VCOMP_STATUS
    group: 205              // same as smart-load-controller VCOMP_GROUP
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

  // Relay control state
  startedAt: Date.now(),     // When this script started, for the startup grace
  identityKnown: false,      // Whether this device knows which role it is running
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // Intended relay state (prevents re-entrancy)
  inputIsActive: false,      // State of the local input

  // Victron data
  currentSoc: 0,             // Current SOC from Victron
  acGeneration: 0,           // AC-coupled generation power (W)
  dcGeneration: 0,           // DC-coupled generation power (W)
  vebusState: 0,             // VE.Bus state (0=Off, 9=Inverting, etc.)
  vebusReceived: false,      // Whether a VE.Bus state has ever arrived. Not cleared on a
                             // broker drop: a stale reading is trouble, an absent one is
                             // only a controller that has just started
  inverterOutput: 0,         // VE.Bus inverter output power (W)

  // Lead relay state
  leadInputActive: false,    // State of the lead relay's input (manual time switch)

  // Control settings
  highSocThreshold: config.soc.highThreshold,
  lowSocThreshold: config.soc.lowThreshold !== null
    ? config.soc.lowThreshold
    : config.soc.highThreshold - 1,

  // Timer
  timerId: null
};

// ===== Virtual component handles =====
let handles = {
  highSocThreshold: null,
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

// One point below the high threshold unless stated outright, so the immersions track
// their threshold slider.
function lowThresholdFor(highThreshold) {
  if (config.soc.lowThreshold !== null) {
    return config.soc.lowThreshold;
  }
  return highThreshold - 1;
}

// Only a dump load sheds on overload or checks headroom: the shortage lead's relay is an
// enable, not a load it could shed.
function contributesToInverterOverload() {
  return config.inverter.heaterPower > 0;
}

// Resolve this device's role from its ID. Called before the virtual components are
// created, since the role decides the threshold they are created with.
function applyRoleForDevice(deviceId) {
  let lead = config.shortageLead;

  if (deviceId.indexOf(lead.deviceId) < 0) {
    return false;
  }

  state.isShortageLead = true;
  config.soc.highThreshold = lead.highThreshold;
  config.soc.lowThreshold = lead.lowThreshold;
  config.minGenerationPower = 0;   // not a dump load: it runs regardless of surplus
  config.inverter.heaterPower = 0;
  config.followTimeSwitch = false; // nothing is wired to its input
  config.groupName = lead.name;

  state.highSocThreshold = lead.highThreshold;
  state.lowSocThreshold = lead.lowThreshold;

  return true;
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
  let thresholdInfo = " [On:" + state.highSocThreshold + "%, Off:" + state.lowSocThreshold + "%]";

  // On .209 the relay is the shortage state itself, so say what it means.
  let relayPart = state.isShortageLead
    ? (state.relayIsOn ? "Heat pump enabled" : "SHORTAGE: heat pump locked")
    : (state.relayIsOn ? "Relay ON" : "Relay OFF");
  let totalGen = state.acGeneration + state.dcGeneration;
  let genPart = ", Gen " + totalGen.toFixed(0) + "W";
  let inverterPart = state.inverterOutput > 0 ? ", Inv " + state.inverterOutput.toFixed(0) + "W" : "";

  let vebusPart = ", VE " + getVebusStateString(state.vebusState);
  let inputPart = ", Input " + (state.inputIsActive ? "ON" : "OFF");
  let leadPart = !state.isLeadRelay ? ", Lead " + (state.leadInputActive ? "ON" : "OFF") : "";

  let eventPart = event ? ": " + event : "";

  let statusMessage = socPart + thresholdInfo + ", " + relayPart + genPart + inverterPart + vebusPart + inputPart + leadPart + eventPart;

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

  // High SOC threshold component (user-configurable). Not on the shortage lead: the
  // slider stops at 50, so it cannot express 30, and 202 is shared with
  // smart-load-controller and could carry a stale value.
  if (!state.isShortageLead &&
      !arrayContains(existingComponentKeys, "number:" + compId.highSocThreshold)) {
    console.log("Creating high SOC threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: compId.highSocThreshold,
      config: {
        name: "High SOC Threshold",
        default_value: state.highSocThreshold,
        min: 50,
        max: 100,
        meta: {
          ui: {
            view: "slider",
            unit: "%",
            step: 1
          }
        },
        persisted: true
      }
    });
  } else {
    logDebug("High SOC threshold component exists");
  }

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

  // Group component
  if (!arrayContains(existingComponentKeys, "group:" + compId.group)) {
    console.log("Creating group component");
    Shelly.call("Virtual.Add", {
      type: "group",
      id: compId.group,
      config: {
        name: config.groupName,
        components: state.isShortageLead
          ? ["text:" + compId.status]
          : ["number:" + compId.highSocThreshold, "text:" + compId.status]
      }
    });
  } else {
    logDebug("Group component exists");
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
    // The shortage source reads no threshold component even if one exists on the device:
    // the numbers live in this file, in one deployment, and nowhere else.
    handles.highSocThreshold = state.isShortageLead
      ? null
      : Virtual.getHandle("number:" + compId.highSocThreshold);
    handles.status = Virtual.getHandle("text:" + compId.status);

    // Load high threshold value
    if (handles.highSocThreshold && handles.highSocThreshold.getValue() !== undefined) {
      state.highSocThreshold = parseFloat(handles.highSocThreshold.getValue());
      state.lowSocThreshold = lowThresholdFor(state.highSocThreshold);
      logDebug("Loaded high SOC threshold: " + state.highSocThreshold + "% (low: " + state.lowSocThreshold + "%)");
    }
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
  console.log("Role: " + (state.isShortageLead ? config.shortageLead.name + " (determines shortage)" : "dump load"));
  console.log("Device is lead relay: " + state.isLeadRelay);
  console.log("High SOC Threshold: " + state.highSocThreshold + "%");
  console.log("Low SOC Threshold: " + state.lowSocThreshold + "%" +
             (config.soc.lowThreshold !== null ? "" : " (auto-calculated)"));
  console.log("Emergency Inverter Limit: " + config.inverter.emergencyLimit + "W");
  console.log("Heater Power (headroom): " + config.inverter.heaterPower + "W" +
             (contributesToInverterOverload() ? "" : " (no overload role)"));
  console.log("Minimum Generation: " + config.minGenerationPower + "W" +
             (config.minGenerationPower > 0 ? "" : " (gate disabled)"));
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  if (state.leadRelayTopic) {
    console.log("Lead Relay Monitoring: " + state.leadRelayTopic);
  }
  console.log("==========================================");

  updateStatus("Monitoring started");
}

// The manual time switch is wired to the lead relay's input and reaches the other
// immersions over MQTT. The shortage lead subscribes to none of it.
function assignLeadRelayTopic() {
  if (state.isShortageLead || state.isLeadRelay) {
    state.leadRelayTopic = "";
    return;
  }

  state.leadRelayTopic = config.leadRelay.inputTopic;
}

// Resolve which device this is. Thresholds, gates and topics all depend on the answer, so
// nothing runs before it and an unreadable identity is retried rather than guessed.
function determineDeviceIdentity(callback) {
  Shelly.call(
    "Shelly.GetDeviceInfo",
    {},
    function(result, error_code, error_message) {
      if (error_code !== 0 || !result || !result.id) {
        // Until this succeeds the controller commands nothing, so every relay keeps its
        // unscripted behaviour.
        console.log("Error getting device info, retrying: " + error_message);
        Timer.set(config.identityRetryDelay, false, function() {
          determineDeviceIdentity(callback);
        });
        return;
      }

      logDebug("Device ID: " + result.id);
      applyRoleForDevice(result.id);
      state.isLeadRelay = (result.id.indexOf(config.leadRelay.deviceId) >= 0);
      assignLeadRelayTopic();
      state.identityKnown = true;

      if (state.isShortageLead) {
        console.log("This device determines shortage - " + config.shortageLead.name);
      } else if (state.isLeadRelay) {
        console.log("This device IS the lead relay - will use local input");
      } else {
        console.log("This device is NOT the lead relay - will monitor: " + state.leadRelayTopic);
      }

      if (callback) callback();
    }
  );
}

// ===== Event handlers =====
function setupEventHandlers() {
  logDebug("Setting up event handlers");

  // High SOC threshold changes
  if (handles.highSocThreshold) {
    try {
      handles.highSocThreshold.on("change", function(ev_info) {
        state.highSocThreshold = parseFloat(ev_info.value || state.highSocThreshold);
        state.lowSocThreshold = lowThresholdFor(state.highSocThreshold);
        updateStatus("SOC thresholds updated: On=" + state.highSocThreshold + "%, Off=" + state.lowSocThreshold + "%");
      });
    } catch (e) {
      console.log("Error setting up threshold handler: " + e.message);
    }
  }

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

        // Log to console on state change (this is a priority control signal)
        if (wasActive !== state.leadInputActive) {
          console.log("Lead relay input " + (state.leadInputActive ? "activated" : "deactivated") + " (manual time switch)");
        }

        logDebug("Lead input updated via MQTT: " + state.leadInputActive);
        updateStatus("Lead input changed");

        // Immediately check system state when lead input changes
        checkSystemState();
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
      // Log on state change
      if (prevState !== state.vebusState) {
        console.log("VE.Bus state: " + state.vebusState + " (" + getVebusStateString(state.vebusState) + ")");
      }
    }

    // Update inverter output - with fast-path emergency suppression
    if (relativeTopic === config.topics.inverterOutput) {
      state.inverterOutput = parseFloat(payload.value);

      // Fast-path emergency suppression if inverter output exceeds safe limit
      if (contributesToInverterOverload() &&
          state.inverterOutput > config.inverter.emergencyLimit && state.relayIsOn) {
        logDebug("EMERGENCY: Inverter output " + state.inverterOutput.toFixed(0) +
                "W exceeds " + config.inverter.emergencyLimit + "W limit - turning off");
        turnRelayOff("Inverter overload protection");
      }
    }
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

  // Ask for a full republish, but not in the same breath as the subscriptions above: sent
  // together, the burst that answers it arrives before they are live and is missed.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
  });

  // Setup periodic keepalive (every 30 seconds).
  //
  // Keep asking for a republish until the VE.Bus state has actually been seen, in case the
  // delay above was not enough. The broker publishes nothing until a value changes, so a
  // state that changes as rarely as this one is only ever seen in a republish. Everything
  // else in the topic set changes every few seconds and so arrives regardless.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.vebusReceived);
  });
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
  state.inverterOutput = 0;
  if (!state.isLeadRelay) {
    state.leadInputActive = false;
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
    // Followers read this device's published switch status and nothing else, so status
    // notifications off means a decision that never leaves the device. Tested for false,
    // not for not-true: a firmware without the key must not reboot on every start.
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

  // Handlers and config first, unconditionally: the device's MQTT client is usually
  // connected before this script starts, and both used to sit behind that early return.
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

// Check if there is sufficient inverter headroom to safely enable the relay
function canSafelyEnable() {
  if (!contributesToInverterOverload()) {
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
  updateStatus("Monitoring");

  // Commanding a relay before the role is known would run .209 as an immersion. Doing
  // nothing is safe in both roles.
  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  // PRIORITY 0: Emergency inverter overload protection (overrides everything)
  // Belt-and-braces for the MQTT fast-path check in processMqttMessage
  if (contributesToInverterOverload() && state.inverterOutput > config.inverter.emergencyLimit) {
    if (state.relayIsOn) {
      turnRelayOff("Inverter overload: " + state.inverterOutput.toFixed(0) + "W");
    }
    return;
  }

  // PRIORITY 1: Local input (for the lead relay, this is the manual time switch)
  // For non-lead relays, local input can still manually override
  if (config.followTimeSwitch && state.inputIsActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Local input active" + (state.isLeadRelay ? " (manual time switch)" : ""));
    }
    return; // Skip other checks when local input is active
  }

  // PRIORITY 2: Lead relay input (manual time switch) - only for non-lead relays
  if (config.followTimeSwitch && !state.isLeadRelay && state.leadInputActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Lead relay input active (manual time switch ON)");
    }
    return; // Skip other checks
  }

  // PRIORITY 3: VE.Bus state check
  // Only allow dump loads when VE.Bus is Inverting (state 9)
  // This covers: inverter off, inverter faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/PowerAssist)
  if (state.vebusState !== 9) {
    // An absent reading is not a stale one: a script that has just started has none yet.
    // Past the grace, silence is the trouble this gate exists for.
    if (!state.vebusReceived && Date.now() - state.startedAt < config.startupGrace) {
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

  // PRIORITY 4: SOC-based control
  if (state.currentSoc <= 0) {
    logDebug("No SOC data available - no action taken");
    return;
  }

  let totalGeneration = state.acGeneration + state.dcGeneration;
  // A minimum of 0 disables the gate outright, rather than resting on the reading being
  // non-negative: a DC source reporting its own draw must not gate anything.
  let sufficientGeneration = config.minGenerationPower <= 0 ||
                             totalGeneration >= config.minGenerationPower;

  logDebug("SOC control: Current=" + state.currentSoc + "%, High=" + state.highSocThreshold +
          "%, Low=" + state.lowSocThreshold + "%, Gen=" + totalGeneration.toFixed(0) + "W" +
          " (need >=" + config.minGenerationPower + "W to enable)");

  // Both directions act at once: SOC is an integral and cannot chatter across the band.
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
    logDebug("Cleared existing timer");
  }

  // Start new timer
  state.timerId = Timer.set(config.checkInterval, true, function() {
    logDebug("Timer triggered check");
    checkStatus();
  });

  // Initial check immediately
  checkStatus();
}

// ===== Initialization =====
function initializeVirtualComponents() {
  logDebug("Initializing virtual components");

  let compId = config.virtualComponents;
  let keys = [
    "number:" + compId.highSocThreshold,
    "text:" + compId.status,
    "group:" + compId.group
  ];

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

  // Identity first: the role decides the threshold the persisted virtual component is
  // created with, so it cannot be resolved after that component already exists.
  determineDeviceIdentity(function() {
    initializeVirtualComponents();
  });
}

// Run initialization
init();
