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
    inputTopic: "shelly1pmg3-543204558fc8/status/input:0", // MQTT topic for lead relay input
    commandTopic: "shelly1pmg3-543204558fc8/command"       // where to ask it to republish
  },

  // The heat pump lock (.209). A dump load follows this rather than working shortage out
  // for itself: closed means the heat pump is running, open means the system is short.
  // One boolean, so the heating relays need nothing from the power system either.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // Every device this file runs on, matched on the ID it reports at startup. The
  // thresholds are properties of the stagger rather than preferences - each immersion sits
  // a point below the last, so they come on in turn rather than all at once - and the
  // shortage numbers are properties of the system. Neither is a knob, so both live here
  // rather than in a slider that can drift from what the documents say.
  //
  // `low` is derived as `high - 1` unless stated: a wide band has to be stated outright.
  // A device not listed here runs nothing, which is what makes a misdirected deploy safe.
  relays: [
    { id: "543204558c6c", name: "DHW Left Top",     high: 96 },
    { id: "543204558fc8", name: "DHW Left Bottom",  high: 94, leadRelay: true },
    { id: "dcda0ce04fb0", name: "DHW Right",        high: 95 },
    { id: "dcda0ce06e98", name: "DHW Annex",        high: 96 },
    // Not a dump load and has no SOC band of its own: its relay is shortage, expressed.
    { id: "d885ac0a3668", name: "Heat Pump Enable", shortageLead: true }
  ],

  // Shortage, worked out by the shortage lead alone and expressed on its relay. Everything
  // else reads the relay, so these numbers exist in one deployment, on one device.
  shortage: {
    lowSoc: 30,        // % - at or below this the system is short. Ten points above the
                       // generator's autostart
    highSoc: 90,       // % - at or above it is not. Above what a generator run reaches,
                       // since the generator stops charging at 80
    minGeneration: 500 // W - settles a controller that started between the two and cannot
                       // know which way the battery was going. "Is any hydro or solar
                       // meaningfully generating", against up to 20 kW of connected
                       // capacity. Separate from config.minGenerationPower, which a role
                       // may disable
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
  startupGrace: 3 * 60 * 1000,  // ms - how long the VE.Bus gate waits for its first reading
                                // before treating silence as trouble. Covers a Cerbo boot
  checkInterval: 30 * 1000,     // 30 seconds in milliseconds

  // Minimum generation required to enable dump loads (W)
  // Prevents enabling with no generation (e.g. post-outage, nighttime)
  // 0 disables the gate
  minGenerationPower: 500,

  // Whether the manual time switch reaches this relay, locally or via the lead relay
  followTimeSwitch: true,

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
  shortageLatch: null,       // Shortage between the thresholds: true, false, or null for
                             // a controller that has not yet resolved which
  vebusReceived: false,      // Whether a VE.Bus state has ever arrived. Not cleared on a
                             // broker drop: a stale reading is trouble, an absent one is
                             // only a controller that has just started
  inverterOutput: 0,         // VE.Bus inverter output power (W)

  // Lead relay state
  leadInputActive: false,    // State of the lead relay's input (manual time switch)
  leadInputReceived: false,  // Whether that state was ever published rather than assumed

  // The heat pump lock, as published by .209. Kept across a broker drop: silence is not
  // .209 saying the battery recovered, and the reconnect asks it again anyway.
  lockIsClosed: false,       // Closed means the heat pump is running: no shortage
  lockKnown: false,          // Never having heard masks nothing, so an undeployed or
                             // unreachable .209 leaves this relay exactly as it was

  // Control settings, taken from the relay table once this device knows which one it is
  deviceName: "",
  highSocThreshold: 0,
  lowSocThreshold: 0,

  // Timer
  timerId: null
};

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

// Only a dump load sheds on overload or checks headroom: the shortage lead's relay is an
// enable, not a load it could shed.
function contributesToInverterOverload() {
  return config.inverter.heaterPower > 0;
}

// Match this device against the relay table and take its settings. Everything depends on
// the answer - thresholds, gates, which topics to follow - so nothing runs before it, and
// a device the table does not list runs nothing at all.
function applySettingsForDevice(deviceId) {
  for (let i = 0; i < config.relays.length; i++) {
    let relay = config.relays[i];

    if (deviceId.indexOf(relay.id) < 0) {
      continue;
    }

    state.deviceName = relay.name;
    state.isLeadRelay = relay.leadRelay === true;
    state.isShortageLead = relay.shortageLead === true;
    // A row without a band is a relay with no dump load behaviour to have one: the
    // shortage lead returns above the SOC term and never consults these.
    if (relay.high !== undefined) {
      state.highSocThreshold = relay.high;
      state.lowSocThreshold = relay.low !== undefined ? relay.low : relay.high - 1;
    }

    if (state.isShortageLead) {
      // An enable, not a dump load: it runs regardless of surplus, has nothing to shed on
      // overload, and hot water is no reason to run a heat pump on a flat battery.
      config.minGenerationPower = 0;
      config.inverter.heaterPower = 0;
      config.followTimeSwitch = false;
    }

    return true;
  }

  return false;
}

// The SOC term, latched: on at or below 30%, off at or above 90%, and between the two it
// holds - or, if it has never been resolved, generation settles it. Why the band is 60
// points wide, and why an unresolved latch assumes shortage, are in CONTROLS.md; the
// durable copy of the answer is this device's own relay contact, read back by
// seedLatchFromRelay.
//
// Nothing here reads the VE.Bus term. That term overlays the latch rather than gating it
// (see inShortage), so the SOC terms settle without waiting on it.
function updateShortageLatch() {
  // Only the shortage lead keeps one. A dump load reads the lock and holds no opinion of
  // its own about the battery.
  if (!state.isShortageLead || state.currentSoc <= 0) {
    return;
  }

  if (state.currentSoc <= config.shortage.lowSoc) {
    state.shortageLatch = true;
  } else if (state.currentSoc >= config.shortage.highSoc) {
    state.shortageLatch = false;
  } else if (state.shortageLatch === null &&
             state.acGeneration + state.dcGeneration > config.shortage.minGeneration) {
    state.shortageLatch = false;
  }
}

// .209's relay contact is the one durable copy of the latch: it survives a script restart,
// and init() has already read it back into state.relayIsOn. Trust it only where a command
// could have put it there. Nothing but a command moves the contact, so the switch's own
// last-command source settles that: `init` means `initial_state` restored at boot and
// nothing since, which is a configuration default rather than a decision - and on a device
// whose default is closed, reading it as one releases the heat pump onto diesel. One
// question answers both a fresh boot and a script deployed hours into one.
function seedLatchFromRelay() {
  if (!state.isShortageLead) {
    return;
  }

  let switchStatus = Shelly.getComponentStatus("switch:0");

  if (!switchStatus || switchStatus.source === "init") {
    logDebug("Nothing has commanded the contact - no latch to read");
    return;
  }

  state.shortageLatch = !state.relayIsOn;
  console.log("Latch read from the relay contact: " +
             (state.shortageLatch ? "shortage" : "no shortage"));
}

// Shortage: the latch, or the VE.Bus term, which is instantaneous and overlays it. Keeping
// them separate is what lets a generator run that ends mid-band return the system to
// wherever it was, rather than holding it locked until the battery next reaches 90%.
//
// An unresolved latch counts as shortage. Null while nothing has been heard at all: an
// absent reading is not a stale one.
function inShortage() {
  if (!state.vebusReceived) {
    // The first poll happens before MQTT has connected and the Cerbo boots slower than the
    // Shelly, so silence is only trouble once the grace has run out.
    return (Date.now() - state.startedAt < config.startupGrace) ? null : true;
  }

  if (state.vebusState !== 9) {
    return true;
  }

  if (state.currentSoc <= 0) {
    return null;
  }

  return state.shortageLatch !== false;
}

// Which reading is missing, for the two ways inShortage() can answer nothing at all: no
// VE.Bus state yet within the grace, or a VE.Bus state and no SOC behind it.
function unresolvedReason() {
  return state.vebusReceived ? "no SOC reading yet" : "nothing heard from the Cerbo yet";
}

// Which term is short, for the log line and the status text.
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
  // The shortage lead has no SOC band of its own: its relay is the shortage terms.
  let thresholdInfo = state.isShortageLead
    ? ""
    : " [On:" + state.highSocThreshold + "%, Off:" + state.lowSocThreshold + "%]";

  // On .209 the relay is the shortage state itself, so say what it means.
  let relayPart = state.isShortageLead
    ? (state.relayIsOn ? "Heat pump enabled" : "SHORTAGE: heat pump locked")
    : (state.relayIsOn ? "Relay ON" : "Relay OFF");
  // .209 says which term is short; a follower says what the lock is doing, and says
  // nothing at all until it has heard, so an immersion running against a .209 that is not
  // there reads exactly as it did before.
  let shortagePart = "";
  if (state.isShortageLead) {
    // Three answers, and the unresolved one must not read as no shortage.
    let shortage = inShortage();
    if (shortage === null) {
      shortagePart = ", " + unresolvedReason();
    } else if (shortage) {
      shortagePart = ", SHORTAGE: " + shortageReason();
    }
  } else if (state.lockKnown) {
    shortagePart = state.lockIsClosed ? ", HP unlocked" : ", SHORTAGE: heat pump locked";
  }
  let totalGen = state.acGeneration + state.dcGeneration;
  let genPart = ", Gen " + totalGen.toFixed(0) + "W";
  let inverterPart = state.inverterOutput > 0 ? ", Inv " + state.inverterOutput.toFixed(0) + "W" : "";

  let vebusPart = ", VE " + getVebusStateString(state.vebusState);
  let inputPart = ", Input " + (state.inputIsActive ? "ON" : "OFF");
  let leadPart = !state.isLeadRelay ? ", Lead " + (state.leadInputActive ? "ON" : "OFF") : "";

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
               config.shortage.minGeneration + "W of generation when unresolved");
  } else {
    console.log("High SOC Threshold: " + state.highSocThreshold + "%");
    console.log("Low SOC Threshold: " + state.lowSocThreshold + "%");
  }
  console.log("Emergency Inverter Limit: " + config.inverter.emergencyLimit + "W");
  console.log("Heater Power (headroom): " + config.inverter.heaterPower + "W" +
             (contributesToInverterOverload() ? "" : " (no overload role)"));
  console.log("Minimum Generation: " + config.minGenerationPower + "W" +
             (config.minGenerationPower > 0 ? "" : " (gate disabled)"));
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

// What each role follows is what it does not own. The manual time switch is wired to the
// lead relay's input and reaches the other immersions over MQTT; the heat pump lock is
// .209's relay, which every dump load reads and .209 itself decides.
function assignFollowedTopics() {
  state.leadRelayTopic = (state.isShortageLead || state.isLeadRelay)
    ? ""
    : config.leadRelay.inputTopic;

  state.lockTopic = state.isShortageLead ? "" : config.heatPumpLock.statusTopic;
}

// Resolve which device this is. Thresholds, gates and topics all depend on the answer, so
// nothing runs before it - and nothing waits for it either: the device ID is local data and
// Shelly.getDeviceInfo() hands it straight back. Returns whether the table knows this
// device; a table that does not runs nothing at all, which is what makes a misdirected
// deploy safe.
function determineDeviceIdentity() {
  let info = Shelly.getDeviceInfo();

  logDebug("Device ID: " + info.id);

  if (!applySettingsForDevice(info.id)) {
    // Not a deployment mistake this script can recover from by waiting, so say so once and
    // leave every relay in the unscripted behaviour its configuration gives.
    console.log("Device " + info.id + " is not in the relay table - doing nothing");
    return false;
  }

  assignFollowedTopics();
  seedLatchFromRelay();
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

        // Immediately check system state when lead input changes
        checkSystemState();
      }
      return;
    }

    // Handle the heat pump lock (never our own: .209 decides it and follows nobody)
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

    // The latch is derived from these readings, so it settles as they arrive rather than
    // waiting out a poll. Acting on it still happens on the poll.
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

  // Subscribe to the heat pump lock (everyone except .209, which decides it)
  if (state.lockTopic) {
    MQTT.subscribe(state.lockTopic, processMqttMessage);
    logDebug("Subscribed to the heat pump lock: " + state.lockTopic);
  }

  // Ask for a full republish, but not in the same breath as the subscriptions above: sent
  // together, the burst that answers it arrives before they are live and is missed.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
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
    requestFollowedStatus(false);
  });
}

// Shelly publishes status on change and does not retain it, so a follower that has just
// started believes the time switch is off and the heat pump running until each device next
// moves - which, for a time clock, can be hours, and for the lock can be days.
// `status_update` on a device's command topic makes it republish every component on the
// topics this controller already subscribes to, so asking costs no extra subscription and
// no HTTP.
//
// Same shape as the keepalive above, for the same reason: ask on connect, and keep asking
// until the answer arrives, since the request itself can be the thing that goes missing.
// Forced on connect, because a value already held may have changed while the broker was
// away and neither device will repeat it.
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
  updateShortageLatch();
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

  // PRIORITY 1: Shortage.
  //
  // On .209 this is the whole job: its relay is the shortage state, expressed. Nothing else
  // works the terms out for itself - they read the relay - so the heating side depends on
  // one boolean, "is the heat pump running", and on nothing from the power system. It also
  // means the lock can be driven by hand: stop this script, set the relay, and the biomass
  // and DHW relays follow.
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

  // A dump load reads the lock instead. Shedding covers the time switch as well as the SOC
  // band: 2.7 kW of hot water is not something to make on a flat battery, and it saves a
  // separate shed for the lead relay, whose hardware follow has already closed it.
  //
  // A lock never heard from masks nothing. The gates below belong to this relay and hold
  // whether or not .209 is alive, so an undeployed or unreachable lock costs the floor and
  // nothing else.
  if (state.lockKnown && !state.lockIsClosed) {
    if (state.relayIsOn) {
      turnRelayOff("SHORTAGE: heat pump locked");
    }
    return;
  }

  // PRIORITY 2: Local input (for the lead relay, this is the manual time switch)
  // For non-lead relays, local input can still manually override
  if (config.followTimeSwitch && state.inputIsActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Local input active" + (state.isLeadRelay ? " (manual time switch)" : ""));
    }
    return; // Skip other checks when local input is active
  }

  // PRIORITY 3: Lead relay input (manual time switch) - only for non-lead relays
  if (config.followTimeSwitch && !state.isLeadRelay && state.leadInputActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Lead relay input active (manual time switch ON)");
    }
    return; // Skip other checks
  }

  // PRIORITY 4: VE.Bus state check
  // Only allow dump loads when VE.Bus is Inverting (state 9)
  // This covers: inverter off, inverter faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/PowerAssist)
  //
  // The lock covers this too, but this relay keeps its own gate: it is one subscription it
  // already holds, and it is what makes a dump load safe with no .209 answering.
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

  // PRIORITY 5: SOC-based control
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

  // Identity first: the role decides the threshold the persisted virtual component is
  // created with, so it cannot be resolved after that component already exists.
  if (!determineDeviceIdentity()) {
    return;
  }

  initializeVirtualComponents();
}

// Run initialization
init();
