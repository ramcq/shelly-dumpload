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
    // When the lead input is ON, all dump load relays should turn on
  },

  // SOC control settings
  soc: {
    highThreshold: 95, // % - enable relay when SOC exceeds this value (configurable via UI)
    // Low threshold is automatically set to highThreshold - 1
  },

  // Timing settings
  minOnTime: 10 * 60 * 1000, // 10 minutes in milliseconds
  checkInterval: 30 * 1000,  // 30 seconds in milliseconds

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    batterySOC: "system/0/Dc/Battery/Soc",
    acSource: "system/0/Ac/ActiveIn/Source" // 0=Unknown;1=Grid;2=Generator;3=Shore;240=Not connected
  },

  // Virtual component IDs (minimal set)
  virtualComponents: {
    highSocThreshold: 200,
    status: 201,
    group: 202
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
  relayIsOn: false,          // Current relay state
  inputIsActive: false,      // State of the local input

  // Victron data
  currentSoc: 0,             // Current SOC from Victron
  acInputConnected: false,   // Current AC input status from Victron

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
    console.log("[DEBUG] " + message);
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

// Update the status display
function updateStatus(event) {
  let socPart = state.currentSoc > 0 ? state.currentSoc + "%" : "No SOC";
  let thresholdInfo = " [On:" + state.highSocThreshold + "%, Off:" + state.lowSocThreshold + "%]";

  let relayPart = state.relayIsOn ? "Relay ON" : "Relay OFF";

  let inputPart = ", Input " + (state.inputIsActive ? "ON" : "OFF");
  let leadPart = !state.isLeadRelay ? ", Lead " + (state.leadInputActive ? "ON" : "OFF") : "";
  let acPart = ", AC-In " + (state.acInputConnected ? "ON" : "OFF");

  let eventPart = event ? ": " + event : "";

  let statusMessage = socPart + thresholdInfo + ", " + relayPart + inputPart + leadPart + acPart + eventPart;

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

  // Determine device identity
  determineDeviceIdentity();

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
  console.log("Minimum On Time: " + (config.minOnTime / (60 * 1000)) + " minutes");
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  if (!state.isLeadRelay) {
    console.log("Lead Relay Monitoring: " + state.leadRelayTopic);
  }
  console.log("==========================================");

  updateStatus("Monitoring started");
}

// Determine if this device is the lead relay
function determineDeviceIdentity() {
  Shelly.call(
    "Shelly.GetDeviceInfo",
    {},
    function(result, error_code, error_message) {
      if (error_code !== 0 || !result || !result.mac) {
        console.log("Error getting device info: " + error_message);
        // Assume we're not the lead relay
        state.isLeadRelay = false;
        state.leadRelayTopic = "shellies/shellyplus1pm-" + config.leadRelay.deviceId + "/status/input:0";
        return;
      }

      // Extract device ID from MAC (last 12 hex chars without colons)
      let mac = result.mac;
      let deviceId = mac.replace(/:/g, "").toLowerCase();

      logDebug("Device MAC: " + mac + ", Device ID: " + deviceId);

      if (deviceId === config.leadRelay.deviceId) {
        state.isLeadRelay = true;
        console.log("This device IS the lead relay - will use local input");
      } else {
        state.isLeadRelay = false;
        state.leadRelayTopic = "shellies/shellyplus1pm-" + config.leadRelay.deviceId + "/status/input:0";
        console.log("This device is NOT the lead relay - will monitor: " + state.leadRelayTopic);
      }
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
    logDebug("Event received: " + JSON.stringify(event));

    if (!event || !event.name || !event.info || !event.info.event)
      return;

    if (event.name === "switch" && event.info.event === "toggle") {
      logDebug("Switch toggle event detected");
      updateRelayState();
      checkSystemState(); // Immediately check state
    }

    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      logDebug("Input toggle event detected");
      updateInputState();
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

  logDebug("MQTT message: " + topic);

  try {
    // Handle lead relay input status (only if we're NOT the lead relay)
    if (!state.isLeadRelay && state.leadRelayTopic && topic === state.leadRelayTopic) {
      let payload = JSON.parse(message);
      if (payload.state !== undefined) {
        state.leadInputActive = Boolean(payload.state);
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
      logDebug("Battery SOC updated: " + state.currentSoc + "%");
    }

    // Update AC input status
    if (relativeTopic === config.topics.acSource) {
      // AC Source: 0=Unknown; 1=Grid; 2=Generator; 3=Shore; 240=Not connected
      state.acInputConnected = (payload.value !== 240);
      logDebug("AC connected updated: " + state.acInputConnected);
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
  state.acInputConnected = false;
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

function connectMqtt() {
  // Clear any pending reconnect timers
  if (state.reconnectTimer) {
    Timer.clear(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  // Check if MQTT is already connected
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

  logDebug("Attempting to connect to MQTT at " + config.cerbo.host + ":" + config.cerbo.port);

  // Configure MQTT if needed
  let mqttConfig = Shelly.getComponentConfig("mqtt");
  let needsConfig = false;

  if (!mqttConfig.enable) {
    needsConfig = true;
    logDebug("MQTT is disabled, enabling it");
  } else if (mqttConfig.server !== config.cerbo.host + ":" + config.cerbo.port) {
    needsConfig = true;
    logDebug("MQTT server doesn't match, reconfiguring");
  }

  if (needsConfig) {
    Shelly.call("MQTT.SetConfig", {
      config: {
        enable: true,
        server: config.cerbo.host + ":" + config.cerbo.port
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
    return;
  }

  // Set up MQTT event handlers
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
}

// ===== Device state management =====
function updateRelayState() {
  Shelly.call(
    "Switch.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting switch status: " + error_message);
        return;
      }

      if (!result || result.output === undefined) {
        console.log("Invalid switch status response");
        return;
      }

      if (state.relayIsOn === result.output)
        return;

      state.relayIsOn = result.output;
      updateStatus("Relay state updated");
    }
  );
}

function updateInputState() {
  Shelly.call(
    "Input.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting input status: " + error_message);
        return;
      }

      if (!result || result.state === undefined) {
        console.log("Invalid input status response");
        return;
      }

      if (state.inputIsActive === result.state)
        return;

      state.inputIsActive = result.state;

      // If we're the lead relay, local input represents the manual time switch
      if (state.isLeadRelay) {
        state.leadInputActive = state.inputIsActive;
        logDebug("Lead input updated from local input: " + state.leadInputActive);
      }

      updateStatus("Input state updated");
    }
  );
}

// ===== Relay control logic =====
function turnRelayOn(reason) {
  logDebug("Attempting to turn relay ON: " + reason);

  Shelly.call(
    "Switch.Set",
    { id: 0, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay on: " + error_message);
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

  Shelly.call(
    "Switch.Set",
    { id: 0, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay off: " + error_message);
        return;
      }

      state.relayIsOn = false;
      updateStatus(reason);
    }
  );
}

function checkSystemState() {
  updateStatus("Monitoring");

  // PRIORITY 1: Local input (for the lead relay, this is the manual time switch)
  // For non-lead relays, local input can still manually override
  if (state.inputIsActive) {
    if (!state.relayIsOn) {
      turnRelayOn("Local input active" + (state.isLeadRelay ? " (manual time switch)" : ""));
    }
    return; // Skip other checks when local input is active
  }

  // PRIORITY 2: Lead relay input (manual time switch) - only for non-lead relays
  if (!state.isLeadRelay && state.leadInputActive) {
    if (!state.relayIsOn) {
      turnRelayOn("Lead relay input active (manual time switch ON)");
    }
    return; // Skip other checks
  }

  // PRIORITY 3: AC input check
  // If AC input is connected, turn off dump load
  if (state.acInputConnected) {
    if (state.relayIsOn) {
      turnRelayOff("AC input connected");
    } else {
      logDebug("AC input connected - no control action");
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

  logDebug("SOC control: Current=" + state.currentSoc + "%, High=" + state.highSocThreshold + "%, Low=" + state.lowSocThreshold + "%");

  // Turn on when SOC reaches high threshold
  if (state.currentSoc >= state.highSocThreshold && !state.relayIsOn) {
    turnRelayOn("SOC high: " + state.currentSoc + "% >= " + state.highSocThreshold + "%");
  }
  // Turn off when SOC reaches low threshold (and minimum on time elapsed)
  else if (state.currentSoc <= state.lowSocThreshold && state.relayIsOn && timeElapsed >= config.minOnTime) {
    turnRelayOff("SOC low: " + state.currentSoc + "% <= " + state.lowSocThreshold + "%");
  }
}

function checkStatus() {
  // Update relay and input state
  Shelly.call(
    "Switch.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting switch status: " + error_message);
        return;
      }

      if (!result || result.output === undefined) {
        console.log("Invalid switch status response");
        return;
      }

      state.relayIsOn = result.output;

      // Also update input state
      updateInputState();

      // Check if action needed
      checkSystemState();
    }
  );
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
  updateRelayState();
  updateInputState();

  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
