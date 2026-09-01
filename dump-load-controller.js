// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Simplified Dump Load Controller for Shelly 1PM Gen3
// Controls relay based on battery SOC from Victron Cerbo GX via MQTT
// Also monitors a "lead" relay's input state (manual time switch) to coordinate multiple relays

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
    // Low threshold is automatically set to highThreshold - 1
  },

  // Inverter overload protection
  inverter: {
    emergencyLimit: 13000,  // W - fast-path emergency shutoff for inverter output
    heaterPower: 2700       // W - approximate power of this heater (for headroom check before enabling)
  },

  // Timing settings
  minOnTime: 10 * 60 * 1000, // 10 minutes in milliseconds
  checkInterval: 30 * 1000,  // 30 seconds in milliseconds

  // Minimum generation required to enable dump loads (W)
  // Prevents enabling with no generation (e.g. post-outage, nighttime)
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
  leadRelayTopic: "",        // MQTT topic to monitor for lead relay input

  // Relay control state
  lastSwitchedOnTime: 0,     // When we last turned the relay on
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // Intended relay state (prevents re-entrancy)
  inputIsActive: false,      // State of the local input

  // Victron data
  currentSoc: 0,             // Current SOC from Victron
  acGeneration: 0,           // AC-coupled generation power (W)
  dcGeneration: 0,           // DC-coupled generation power (W)
  vebusState: 0,             // VE.Bus state (0=Off, 9=Inverting, etc.)
  inverterOutput: 0,         // VE.Bus inverter output power (W)

  // Lead relay state
  leadInputActive: false,    // State of the lead relay's input (manual time switch)

  // Control settings
  highSocThreshold: config.soc.highThreshold,
  lowSocThreshold: config.soc.highThreshold - 1, // Auto-calculated

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

  let relayPart = state.relayIsOn ? "Relay ON" : "Relay OFF";
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

  // High SOC threshold component (user-configurable)
  if (!arrayContains(existingComponentKeys, "number:" + compId.highSocThreshold)) {
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
        name: "Dump Load Controller",
        components: [
          "number:" + compId.highSocThreshold,
          "text:" + compId.status
        ]
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
    handles.highSocThreshold = Virtual.getHandle("number:" + compId.highSocThreshold);
    handles.status = Virtual.getHandle("text:" + compId.status);

    // Load high threshold value
    if (handles.highSocThreshold && handles.highSocThreshold.getValue() !== undefined) {
      state.highSocThreshold = parseFloat(handles.highSocThreshold.getValue());
      state.lowSocThreshold = state.highSocThreshold - 1; // Auto-calculate
      logDebug("Loaded high SOC threshold: " + state.highSocThreshold + "% (low: " + state.lowSocThreshold + "%)");
    }
  } catch (e) {
    console.log("Error getting component handles: " + e.message);
  }

  // Determine device identity first, then continue initialization
  determineDeviceIdentity(function() {
    // Set up event handlers
    setupEventHandlers();

    // Start MQTT connection
    connectMqtt();

    // Start monitoring loop
    startMonitoring();

    console.log("=== Dump Load Controller Configuration ===");
    console.log("Device is lead relay: " + state.isLeadRelay);
    console.log("High SOC Threshold: " + state.highSocThreshold + "%");
    console.log("Low SOC Threshold: " + state.lowSocThreshold + "% (auto-calculated)");
    console.log("Emergency Inverter Limit: " + config.inverter.emergencyLimit + "W");
    console.log("Heater Power (headroom): " + config.inverter.heaterPower + "W");
    console.log("Minimum On Time: " + (config.minOnTime / (60 * 1000)) + " minutes");
    console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
    if (!state.isLeadRelay) {
      console.log("Lead Relay Monitoring: " + state.leadRelayTopic);
    }
    console.log("==========================================");

    updateStatus("Monitoring started");
  });
}

// Determine if this device is the lead relay
function determineDeviceIdentity(callback) {
  Shelly.call(
    "Shelly.GetDeviceInfo",
    {},
    function(result, error_code, error_message) {
      if (error_code !== 0 || !result || !result.id) {
        console.log("Error getting device info: " + error_message);
        state.isLeadRelay = false;
      } else {
        logDebug("Device ID: " + result.id);
        state.isLeadRelay = (result.id.indexOf(config.leadRelay.deviceId) >= 0);
      }

      if (state.isLeadRelay) {
        console.log("This device IS the lead relay - will use local input");
      } else {
        state.leadRelayTopic = config.leadRelay.inputTopic;
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
        state.lowSocThreshold = state.highSocThreshold - 1; // Auto-calculate
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
        if (newState) {
          state.lastSwitchedOnTime = Date.now();
        }
        logDebug("Relay state changed as expected to: " + newState);
        return; // Don't call checkSystemState - this was our intended action
      } else {
        // Unexpected change (manual toggle or external control)
        state.relayIsOn = newState;
        state.intendedRelayOn = newState; // Sync intended with actual
        if (newState) {
          state.lastSwitchedOnTime = Date.now();
        }
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
      // Log on state change
      if (prevState !== state.vebusState) {
        console.log("VE.Bus state: " + state.vebusState + " (" + getVebusStateString(state.vebusState) + ")");
      }
    }

    // Update inverter output - with fast-path emergency suppression
    if (relativeTopic === config.topics.inverterOutput) {
      state.inverterOutput = parseFloat(payload.value);

      // Fast-path emergency suppression if inverter output exceeds safe limit
      if (state.inverterOutput > config.inverter.emergencyLimit && state.relayIsOn) {
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

  // Send initial keepalive
  sendKeepalive(false);

  // Setup periodic keepalive (every 30 seconds)
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(true);
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
      state.lastSwitchedOnTime = Date.now();
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

  // PRIORITY 0: Emergency inverter overload protection (overrides everything)
  // Belt-and-braces for the MQTT fast-path check in processMqttMessage
  if (state.inverterOutput > config.inverter.emergencyLimit) {
    if (state.relayIsOn) {
      turnRelayOff("Inverter overload: " + state.inverterOutput.toFixed(0) + "W");
    }
    return;
  }

  // PRIORITY 1: Local input (for the lead relay, this is the manual time switch)
  // For non-lead relays, local input can still manually override
  if (state.inputIsActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Local input active" + (state.isLeadRelay ? " (manual time switch)" : ""));
    }
    return; // Skip other checks when local input is active
  }

  // PRIORITY 2: Lead relay input (manual time switch) - only for non-lead relays
  if (!state.isLeadRelay && state.leadInputActive) {
    if (!state.relayIsOn && canSafelyEnable()) {
      turnRelayOn("Lead relay input active (manual time switch ON)");
    }
    return; // Skip other checks
  }

  // PRIORITY 3: VE.Bus state check
  // Only allow dump loads when VE.Bus is Inverting (state 9)
  // This covers: inverter off, inverter faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/PowerAssist)
  if (state.vebusState !== 9) {
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

  let currentTime = Date.now();
  let timeElapsed = currentTime - state.lastSwitchedOnTime;

  let totalGeneration = state.acGeneration + state.dcGeneration;
  let sufficientGeneration = totalGeneration >= config.minGenerationPower;

  logDebug("SOC control: Current=" + state.currentSoc + "%, High=" + state.highSocThreshold +
          "%, Low=" + state.lowSocThreshold + "%, Gen=" + totalGeneration.toFixed(0) + "W" +
          " (need >=" + config.minGenerationPower + "W to enable)");

  // Turn on when SOC reaches high threshold AND sufficient generation is available
  if (state.currentSoc >= state.highSocThreshold && !state.relayIsOn && sufficientGeneration && canSafelyEnable()) {
    turnRelayOn("SOC high + gen: " + state.currentSoc + "% >= " + state.highSocThreshold + "%, gen " + totalGeneration.toFixed(0) + "W");
  }
  // Turn off when SOC reaches low threshold (and minimum on time elapsed)
  else if (state.currentSoc <= state.lowSocThreshold && state.relayIsOn && timeElapsed >= config.minOnTime) {
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
  console.log("Dump Load Controller Script starting");

  // Initial state update
  updateDeviceState();

  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
