// Thermal Dump Controller for Shelly 2 PM Gen3
// Controls pump (output 1) and fan coil (output 0) based on:
// 1. Frost thermostat input (unconditional)
// 2. Monitored relay states (voltage present, no consumption)
// 3. Tank temperatures and boiler status

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000
  },

  // Relays to monitor for dump load active status
  // Monitor these for: output ON + voltage present + no consumption
  monitoredRelays: [
    // Dump load relays (Shelly Plus 1PM)
    {
      name: "Dump Load 1",
      statusTopic: "shellies/shellyplus1pm-XXXXXX/status/switch:0" // Replace XXXXXX with device ID
    },
    {
      name: "Dump Load 2",
      statusTopic: "shellies/shellyplus1pm-YYYYYY/status/switch:0" // Replace YYYYYY with device ID
    },
    {
      name: "Dump Load 3",
      statusTopic: "shellies/shellyplus1pm-ZZZZZZ/status/switch:0" // Replace ZZZZZZ with device ID
    },
    // Shelly Pro 2PM (ec6260a03d70) - has 2 switches
    {
      name: "Pro 2PM Switch 0",
      statusTopic: "shellies/shellypro2pm-ec6260a03d70/status/switch:0"
    },
    {
      name: "Pro 2PM Switch 1",
      statusTopic: "shellies/shellypro2pm-ec6260a03d70/status/switch:1"
    },
    // Shelly Pro Dimmer 0/1-10V PM (8813bfe0e128) - has 1 switch
    {
      name: "Pro Dimmer",
      statusTopic: "shellies/shellyprodimmer0110v-8813bfe0e128/status/switch:0"
    }
  ],

  // Temperature and power thresholds
  thresholds: {
    minTankTemp: 70,          // °C - minimum tank temperature to enable pump
    maxTempDelta: 5,          // °C - max delta between top and bottom for fan coil
    minVoltage: 200,          // V - minimum voltage to consider "voltage present"
    maxConsumption: 5,        // W - maximum consumption to consider "no load"
  },

  // Victron topics for tank temperatures and boiler status
  topics: {
    topTankTemp: "system/0/Dc/Tank/Temperature/Top",    // Adjust based on actual Victron setup
    bottomTankTemp: "system/0/Dc/Tank/Temperature/Bottom", // Adjust based on actual Victron setup
    boilerOperating: "system/0/Dc/Relay/0/State"        // Adjust based on actual boiler relay
  },

  // Timing settings
  checkInterval: 10 * 1000,  // 10 seconds in milliseconds
  minRunTime: 5 * 60 * 1000, // 5 minutes minimum run time

  // Virtual component IDs (minimal set)
  virtualComponents: {
    status: 200,
    group: 201
  },

  // Debug mode
  debugMode: true
};

// Output IDs for Shelly 2 PM Gen3
const OUTPUT_FAN_COIL = 0; // Output 1 (index 0)
const OUTPUT_PUMP = 1;     // Output 2 (index 1)

// ===== State variables =====
let state = {
  // MQTT connection
  mqttConnected: false,
  keepaliveTimer: null,
  reconnectTimer: null,

  // Input state (frost thermostat)
  frostThermostatActive: false,

  // Output states
  fanCoilOn: false,
  pumpOn: false,
  fanCoilOnTime: 0,
  pumpOnTime: 0,

  // Monitored relay states
  monitoredRelays: [],

  // Temperature data
  topTankTemp: 0,
  bottomTankTemp: 0,
  boilerOperating: false,

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
    console.log("[DEBUG-THERMAL] " + message);
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

// Check if any monitored relay is active
function isAnyRelayActive() {
  for (let i = 0; i < state.monitoredRelays.length; i++) {
    let relay = state.monitoredRelays[i];
    if (relay.output &&
        relay.voltage >= config.thresholds.minVoltage &&
        relay.power <= config.thresholds.maxConsumption) {
      return true;
    }
  }
  return false;
}

// Update the status display
function updateStatus(event) {
  let frostPart = state.frostThermostatActive ? "FROST ACTIVE" : "Frost OK";
  let fanPart = ", Fan " + (state.fanCoilOn ? "ON" : "OFF");
  let pumpPart = ", Pump " + (state.pumpOn ? "ON" : "OFF");

  let tempDelta = state.topTankTemp - state.bottomTankTemp;
  let tempPart = ", Tank " + state.topTankTemp.toFixed(1) + "/" + state.bottomTankTemp.toFixed(1) + "°C";
  let deltaPart = " (Δ" + tempDelta.toFixed(1) + "°C)";
  let boilerPart = ", Boiler " + (state.boilerOperating ? "ON" : "OFF");

  let anyRelayActive = isAnyRelayActive();
  let relayPart = ", Relays " + (anyRelayActive ? "ACTIVE" : "inactive");

  let eventPart = event ? ": " + event : "";

  let statusMessage = frostPart + fanPart + pumpPart + tempPart + deltaPart + boilerPart + relayPart + eventPart;

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

  // Group component
  if (!arrayContains(existingComponentKeys, "group:" + compId.group)) {
    console.log("Creating group component");
    Shelly.call("Virtual.Add", {
      type: "group",
      id: compId.group,
      config: {
        name: "Thermal Dump Controller",
        components: [
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
    handles.status = Virtual.getHandle("text:" + compId.status);
  } catch (e) {
    console.log("Error getting component handles: " + e.message);
  }

  // Initialize monitored relay state array
  for (let i = 0; i < config.monitoredRelays.length; i++) {
    state.monitoredRelays.push({ output: false, voltage: 0, power: 0 });
  }

  // Set up event handlers
  setupEventHandlers();

  // Start MQTT connection
  connectMqtt();

  // Start monitoring loop
  startMonitoring();

  console.log("=== Thermal Dump Controller Configuration ===");
  console.log("Device: Shelly 2 PM Gen3 (2 outputs)");
  console.log("Min Tank Temperature: " + config.thresholds.minTankTemp + "°C");
  console.log("Max Temp Delta for Fan: " + config.thresholds.maxTempDelta + "°C");
  console.log("Min Voltage: " + config.thresholds.minVoltage + "V");
  console.log("Max Consumption: " + config.thresholds.maxConsumption + "W");
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  console.log("Monitoring " + config.monitoredRelays.length + " relays");
  console.log("==============================================");

  updateStatus("Monitoring started");
}

// ===== Event handlers =====
function setupEventHandlers() {
  logDebug("Setting up event handlers");

  // Watch for input and switch events
  Shelly.addEventHandler(function(event) {
    logDebug("Event received: " + JSON.stringify(event));

    if (!event || !event.name || !event.info || !event.info.event)
      return;

    // Input toggle (frost thermostat)
    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      logDebug("Input toggle event detected");
      updateInputState();
      checkSystemState(); // Immediately check state
    }

    // Switch toggle (outputs)
    if (event.name === "switch") {
      logDebug("Switch event detected");
      updateOutputStates();
    }
  });
}

// ===== MQTT connection and message handling =====
function processMqttMessage(topic, message) {
  if (message.length === 0) {
    logDebug("Empty message for topic: " + topic);
    return;
  }

  logDebug("MQTT message: " + topic);

  try {
    let payload = JSON.parse(message);

    // Check if this is a monitored relay status message
    for (let i = 0; i < config.monitoredRelays.length; i++) {
      if (topic === config.monitoredRelays[i].statusTopic) {
        if (payload.output !== undefined) {
          state.monitoredRelays[i].output = Boolean(payload.output);
        }
        if (payload.voltage !== undefined) {
          state.monitoredRelays[i].voltage = parseFloat(payload.voltage);
        }
        if (payload.apower !== undefined) {
          state.monitoredRelays[i].power = parseFloat(payload.apower);
        }
        logDebug(config.monitoredRelays[i].name + ": output=" + state.monitoredRelays[i].output +
                ", voltage=" + state.monitoredRelays[i].voltage + "V" +
                ", power=" + state.monitoredRelays[i].power + "W");
        return;
      }
    }

    // Handle Victron Cerbo GX messages
    let topicPrefix = "N/" + config.cerbo.portalId + "/";
    if (topic.indexOf(topicPrefix) !== 0)
      return;

    let relativeTopic = topic.substring(topicPrefix.length);

    if (!payload.hasOwnProperty("value") || payload.value === null) {
      logDebug("Ignoring message with null value");
      return;
    }

    // Update top tank temperature
    if (relativeTopic === config.topics.topTankTemp) {
      state.topTankTemp = parseFloat(payload.value);
      logDebug("Top tank temp updated: " + state.topTankTemp + "°C");
    }

    // Update bottom tank temperature
    if (relativeTopic === config.topics.bottomTankTemp) {
      state.bottomTankTemp = parseFloat(payload.value);
      logDebug("Bottom tank temp updated: " + state.bottomTankTemp + "°C");
    }

    // Update boiler operating status
    if (relativeTopic === config.topics.boilerOperating) {
      state.boilerOperating = Boolean(payload.value);
      logDebug("Boiler operating updated: " + state.boilerOperating);
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

  // Subscribe to monitored relay topics
  for (let i = 0; i < config.monitoredRelays.length; i++) {
    MQTT.subscribe(config.monitoredRelays[i].statusTopic, processMqttMessage);
    logDebug("Subscribed to: " + config.monitoredRelays[i].statusTopic);
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
  for (let i = 0; i < state.monitoredRelays.length; i++) {
    state.monitoredRelays[i].output = false;
    state.monitoredRelays[i].voltage = 0;
    state.monitoredRelays[i].power = 0;
  }
  state.topTankTemp = 0;
  state.bottomTankTemp = 0;
  state.boilerOperating = false;

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

      if (state.frostThermostatActive === result.state)
        return;

      state.frostThermostatActive = result.state;
      updateStatus("Frost thermostat changed");
    }
  );
}

function updateOutputStates() {
  // Check output 0 (fan coil)
  Shelly.call(
    "Switch.GetStatus",
    { id: OUTPUT_FAN_COIL },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting fan coil status: " + error_message);
        return;
      }

      if (!result || result.output === undefined) {
        console.log("Invalid fan coil status response");
        return;
      }

      state.fanCoilOn = result.output;
    }
  );

  // Check output 1 (pump)
  Shelly.call(
    "Switch.GetStatus",
    { id: OUTPUT_PUMP },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting pump status: " + error_message);
        return;
      }

      if (!result || result.output === undefined) {
        console.log("Invalid pump status response");
        return;
      }

      state.pumpOn = result.output;
    }
  );
}

// ===== Output control logic =====
function turnOutputOn(outputId, outputName, reason) {
  logDebug("Attempting to turn " + outputName + " ON: " + reason);

  Shelly.call(
    "Switch.Set",
    { id: outputId, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning " + outputName + " on: " + error_message);
        return;
      }

      if (outputId === OUTPUT_FAN_COIL) {
        state.fanCoilOn = true;
        state.fanCoilOnTime = Date.now();
      } else if (outputId === OUTPUT_PUMP) {
        state.pumpOn = true;
        state.pumpOnTime = Date.now();
      }

      updateStatus(reason);
    }
  );
}

function turnOutputOff(outputId, outputName, reason) {
  let onTime = (outputId === OUTPUT_FAN_COIL) ? state.fanCoilOnTime : state.pumpOnTime;

  // Check minimum run time
  let currentTime = Date.now();
  let timeElapsed = currentTime - onTime;
  if (timeElapsed < config.minRunTime) {
    logDebug("Not turning " + outputName + " off - minimum run time not elapsed (" +
            (timeElapsed / 1000).toFixed(0) + "s / " + (config.minRunTime / 1000) + "s)");
    return;
  }

  logDebug("Attempting to turn " + outputName + " OFF: " + reason);

  Shelly.call(
    "Switch.Set",
    { id: outputId, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning " + outputName + " off: " + error_message);
        return;
      }

      if (outputId === OUTPUT_FAN_COIL) {
        state.fanCoilOn = false;
      } else if (outputId === OUTPUT_PUMP) {
        state.pumpOn = false;
      }

      updateStatus(reason);
    }
  );
}

function checkSystemState() {
  updateStatus("Monitoring");

  // PRIORITY 1: Frost thermostat
  // If frost thermostat is active, turn on BOTH outputs unconditionally
  if (state.frostThermostatActive) {
    if (!state.fanCoilOn) {
      turnOutputOn(OUTPUT_FAN_COIL, "Fan Coil", "FROST PROTECTION");
    }
    if (!state.pumpOn) {
      turnOutputOn(OUTPUT_PUMP, "Pump", "FROST PROTECTION");
    }
    return; // Skip other checks
  }

  // PRIORITY 2: Check if any monitored relay is active
  let anyRelayActive = isAnyRelayActive();

  if (!anyRelayActive) {
    // No relay active - turn off both outputs
    if (state.pumpOn) {
      turnOutputOff(OUTPUT_PUMP, "Pump", "No relay active");
    }
    if (state.fanCoilOn) {
      turnOutputOff(OUTPUT_FAN_COIL, "Fan Coil", "No relay active");
    }
    return;
  }

  // At least one relay is active - check conditions for pump and fan coil

  // PUMP LOGIC: Turn on if tank temp > minTankTemp AND boiler not operating
  let pumpConditionMet = (state.topTankTemp > config.thresholds.minTankTemp && !state.boilerOperating);

  if (pumpConditionMet && !state.pumpOn) {
    turnOutputOn(OUTPUT_PUMP, "Pump", "Tank hot (" + state.topTankTemp.toFixed(1) + "°C), boiler off, relay active");
  } else if (!pumpConditionMet && state.pumpOn) {
    let reason = "Conditions not met: ";
    if (state.topTankTemp <= config.thresholds.minTankTemp) {
      reason += "tank too cold (" + state.topTankTemp.toFixed(1) + "°C)";
    } else if (state.boilerOperating) {
      reason += "boiler operating";
    }
    turnOutputOff(OUTPUT_PUMP, "Pump", reason);
  }

  // FAN COIL LOGIC: Turn on if pump conditions met AND temp delta is low
  let tempDelta = state.topTankTemp - state.bottomTankTemp;
  let fanConditionMet = pumpConditionMet && (tempDelta <= config.thresholds.maxTempDelta);

  if (fanConditionMet && !state.fanCoilOn) {
    turnOutputOn(OUTPUT_FAN_COIL, "Fan Coil", "Tank hot, low delta (" + tempDelta.toFixed(1) + "°C), relay active");
  } else if (!fanConditionMet && state.fanCoilOn) {
    let reason = "Conditions not met: ";
    if (!pumpConditionMet) {
      reason += "pump conditions not met";
    } else if (tempDelta > config.thresholds.maxTempDelta) {
      reason += "temp delta too high (" + tempDelta.toFixed(1) + "°C)";
    }
    turnOutputOff(OUTPUT_FAN_COIL, "Fan Coil", reason);
  }
}

function checkStatus() {
  // Update input and output states
  updateInputState();
  updateOutputStates();

  // Check if action needed
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
  console.log("Thermal Dump Controller Script starting");

  // Initial state update
  updateInputState();
  updateOutputStates();

  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
