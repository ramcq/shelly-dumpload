// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
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
    portalId: "c0847dc9a794" // VRM portal ID
  },

  // The buffer immersions, one entry per stage that surplus-dump-controller.js can switch.
  // Each is watched for output ON + voltage present + no consumption, which is the thermal
  // cutout having opened. When ANY of them is cut out, the thermal dump can operate.
  // Keep this list in step with the stages in surplus-dump-controller.js: an immersion that
  // can be switched but is not listed here cuts out with nothing to recover it.
  dumpLoads: [
    // Shelly Pro 2PM (ec6260a03d70) - 2 switches
    {
      name: "Buffer Immersion 1",
      statusTopic: "shellypro2pm-ec6260a03d70/status/switch:0"
    },
    {
      name: "Buffer Immersion 2",
      statusTopic: "shellypro2pm-ec6260a03d70/status/switch:1"
    },
    // Shelly Pro Dimmer 0/1-10V PM (8813bfe0e128) - 1 "light"
    {
      name: "Buffer Immersion 3",
      statusTopic: "shellypro0110pm-8813bfe0e128/status/light:0"
    },
    // Shelly Pro 1PM (5c013b056870) - 1 switch
    {
      name: "Buffer Immersion 4",
      statusTopic: "shellypro1pm-5c013b056870/status/switch:0"
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
    topTankTemp: "temperature/100/Temperature",      // Top tank temperature sensor
    bottomTankTemp: "temperature/101/Temperature",   // Bottom tank temperature sensor
    boilerOperating: "digitalinput/102/State"        // Boiler digital input (10=running, 11=stopped)
  },

  // Timing settings
  checkInterval: 10 * 1000,  // 10 seconds in milliseconds
  minRunTime: 5 * 60 * 1000, // 5 minutes minimum run time

  // A yield, not a wait: MQTT.subscribe is only acted on once the script returns to the
  // main loop, so a republish asked for in the same breath is answered before anything is
  // listening. The length hardly matters - a millisecond would do - only that it lands on
  // a later turn of the loop.
  initialKeepaliveDelay: 1000,  // ms - after subscribing, before asking for a republish

  // Virtual component IDs (minimal set)
  virtualComponents: {
    status: 200
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

  // Input state (frost thermostat)
  frostThermostatActive: false,

  // Output states - array of output objects
  outputs: [
    {
      id: OUTPUT_FAN_COIL,
      name: "Fan Coil",
      on: false,           // Actual state
      intended: false,     // Intended state (for re-entrancy prevention)
      onTime: 0            // Timestamp when turned on
    },
    {
      id: OUTPUT_PUMP,
      name: "Pump",
      on: false,
      intended: false,
      onTime: 0
    }
  ],

  // Dump load states
  dumpLoads: [],

  // Temperature data
  topTankTemp: 0,
  bottomTankTemp: 0,
  boilerOperating: false,
  boilerReceived: false,     // Whether that was published rather than assumed

  // Timer
  timerId: null
};

// One state entry per watched load, built here rather than during setup so the array
// exists before any status message can arrive and cannot drift from the config.
for (let i = 0; i < config.dumpLoads.length; i++) {
  state.dumpLoads.push({ output: false, voltage: 0, power: 0 });
}

// Helper to get output object by ID
function getOutput(outputId) {
  return state.outputs[outputId];
}

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

// Check if a single dump load is in thermal cutout (stalled)
// Stalled = output ON + voltage present + negligible power consumption
function isLoadStalled(load) {
  return load.output &&
         load.voltage >= config.thresholds.minVoltage &&
         load.power <= config.thresholds.maxConsumption;
}

// Check if any dump load is stalled
function isDumpLoadStalled() {
  for (let i = 0; i < state.dumpLoads.length; i++) {
    if (isLoadStalled(state.dumpLoads[i])) {
      return true;
    }
  }
  return false;
}

// Get dump load tri-state: OFF, ON (heating), or STALLED (thermal cutout)
function getDumpLoadState() {
  let anyOn = false;
  let anyStalled = false;

  for (let i = 0; i < state.dumpLoads.length; i++) {
    let relay = state.dumpLoads[i];
    if (isLoadStalled(relay)) {
      anyStalled = true;
    } else if (relay.output && relay.power > config.thresholds.maxConsumption) {
      anyOn = true;
    }
  }

  if (anyStalled) {
    return "STALLED";
  } else if (anyOn) {
    return "ON";
  } else {
    return "OFF";
  }
}

// Update the status display
function updateStatus(event) {
  let frostPart = state.frostThermostatActive ? "FROST ACTIVE" : "Frost:OK";
  let fanPart = " Fan:" + (getOutput(OUTPUT_FAN_COIL).on ? "ON" : "OFF");
  let pumpPart = " Pump:" + (getOutput(OUTPUT_PUMP).on ? "ON" : "OFF");

  let tempDelta = state.topTankTemp - state.bottomTankTemp;
  let tempPart = " Tank:" + state.topTankTemp.toFixed(1) + "/" + state.bottomTankTemp.toFixed(1) + "°C";
  let deltaPart = " Δ" + tempDelta.toFixed(1);
  // "?" is not "OFF": one permits dumping and the other inhibits it, and the status text is
  // the only instrument on a device that keeps no log across a restart.
  let boilerPart = " Boiler:" +
    (!state.boilerReceived ? "?" : (state.boilerOperating ? "ON" : "OFF"));

  let dumpState = getDumpLoadState();
  let dumpPart = " Dump:" + dumpState;

  let eventPart = event ? " - " + event : "";

  let statusMessage = frostPart + fanPart + pumpPart + tempPart + deltaPart + boilerPart + dumpPart + eventPart;

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

  console.log("=== Thermal Dump Controller Configuration ===");
  console.log("Device: Shelly 2 PM Gen3 (2 outputs)");
  console.log("Min Tank Temperature: " + config.thresholds.minTankTemp + "°C");
  console.log("Max Temp Delta for Fan: " + config.thresholds.maxTempDelta + "°C");
  console.log("Min Voltage: " + config.thresholds.minVoltage + "V");
  console.log("Max Consumption: " + config.thresholds.maxConsumption + "W");
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  console.log("Monitoring " + config.dumpLoads.length + " dump load switches (Pro 2PM x2, Pro Dimmer x1, Pro 1PM x1)");
  console.log("==============================================");

  updateStatus("Monitoring started");
}

// ===== Event handlers =====
function setupEventHandlers() {
  logDebug("Setting up event handlers");

  // Watch for input and switch events
  Shelly.addEventHandler(function(event) {
    if (!event || !event.name || !event.info || !event.info.event)
      return;

    if (event.info.event == "power_measurement" ||
        event.info.event == "power_update" ||
        event.info.event == "current_update" ||
        event.info.event == "pf_update" ||
        event.info.event == "ret_aenergy_update" ||
        event.info.event == "aenergy_update")
      return;

    logDebug("Event received: " + JSON.stringify(event));

    // Input toggle (frost thermostat)
    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      logDebug("Input toggle event detected");

      // Update state directly from event object to avoid RPC re-entrancy
      if (event.info.state === undefined) {
        logDebug("Warning: event.info.state is undefined");
        return;
      }

      let newState = Boolean(event.info.state);
      if (state.frostThermostatActive === newState) {
        logDebug("Frost thermostat state unchanged: " + newState);
        return; // Early return if no change
      }

      state.frostThermostatActive = newState;
      logDebug("Frost thermostat state updated to: " + state.frostThermostatActive);
      updateStatus("Frost thermostat changed");

      // Check system state after updating from event (not from RPC callback)
      checkSystemState();
    }

    // Switch toggle (outputs changed by firmware or other means)
    if (event.name === "switch" && event.info.event === "toggle") {
      logDebug("Switch toggle event detected");

      if (event.info.id === undefined || event.info.state === undefined) {
        logDebug("Warning: event.info.id or event.info.state is undefined");
        return;
      }

      let switchId = event.info.id;
      let newState = Boolean(event.info.state);
      let output = getOutput(switchId);

      if (!output) {
        logDebug("Warning: unknown switch ID " + switchId);
        return;
      }

      // Check if this is an expected change (from our own RPC calls)
      if (newState === output.intended) {
        // Expected change - just update actual state and return
        if (output.on !== newState) {
          output.on = newState;
          if (newState) {
            output.onTime = Date.now();
          }
          logDebug(output.name + " state updated to: " + output.on + " (expected)");
          updateStatus(output.name + " changed");
        }
        return; // Early return - don't call checkSystemState for expected changes
      } else {
        // Unexpected external change - update both actual and intended, then reconcile
        if (output.on !== newState) {
          output.on = newState;
          if (newState) {
            output.onTime = Date.now();
          }
        }
        output.intended = newState; // Sync intended to actual
        logDebug(output.name + " state updated to: " + output.on + " (changed externally)");
        updateStatus(output.name + " changed externally");
        // Fall through to checkSystemState
      }

      // Check system state only after external changes to reconcile
      checkSystemState();
    }
  });
}

// ===== MQTT connection and message handling =====
function processMqttMessage(topic, message) {
  if (message.length === 0) {
    logDebug("Empty message for topic: " + topic);
    return;
  }

  try {
    let payload = JSON.parse(message);

    // Check if this is a dump load status message
    for (let i = 0; i < config.dumpLoads.length; i++) {
      if (topic === config.dumpLoads[i].statusTopic) {
        if (payload.output !== undefined) {
          state.dumpLoads[i].output = Boolean(payload.output);
        }
        if (payload.voltage !== undefined) {
          state.dumpLoads[i].voltage = parseFloat(payload.voltage);
        }
        if (payload.apower !== undefined) {
          state.dumpLoads[i].power = parseFloat(payload.apower);
        }
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
    }

    // Update bottom tank temperature
    if (relativeTopic === config.topics.bottomTankTemp) {
      state.bottomTankTemp = parseFloat(payload.value);
    }

    // Update boiler operating status (10=running, 11=stopped)
    if (relativeTopic === config.topics.boilerOperating) {
      state.boilerOperating = (payload.value === 10);
      logDebug("Boiler operating updated: " + state.boilerOperating + " (state=" + payload.value + ")");

      // Worth a console line rather than a debug one: until this arrives the thermal dump
      // is inhibited, so this is the moment it becomes able to run at all.
      if (!state.boilerReceived) {
        state.boilerReceived = true;
        console.log("Boiler state received: " +
                   (state.boilerOperating ? "operating" : "stopped"));
      }
    }
  } catch (e) {
    console.log("Error processing MQTT message: " + e.message);
  }
}

function setupMqttSubscriptionsAndKeepalive() {
  logDebug("Setting up MQTT subscriptions and keepalive");

  // Subscribe to Victron topics
  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.topics) {
    let topic = topicPrefix + config.topics[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  // Subscribe to dump load topics
  for (let i = 0; i < config.dumpLoads.length; i++) {
    MQTT.subscribe(config.dumpLoads[i].statusTopic, processMqttMessage);
    logDebug("Subscribed to: " + config.dumpLoads[i].statusTopic);
  }

  // Ask for a full republish, but from a later turn of the main loop than the
  // subscriptions above - see config.initialKeepaliveDelay.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
  });

  // Setup periodic keepalive (every 30 seconds).
  //
  // Keep asking for a republish until the boiler state has actually been seen, in case the
  // yield above was not enough. The broker publishes nothing until a value changes, and the
  // boiler input moves only when the boiler starts or stops firing - several times a day
  // while it is lit, and not at all through a spell with power to spare - so between
  // transitions it is only ever seen in a republish. The tank temperatures drift constantly
  // and so arrive regardless.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.boilerReceived);
  });
}

function handleMqttConnected() {
  console.log("Connected to MQTT broker");
  state.mqttConnected = true;
  setupMqttSubscriptionsAndKeepalive();
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
  for (let i = 0; i < state.dumpLoads.length; i++) {
    state.dumpLoads[i].output = false;
    state.dumpLoads[i].voltage = 0;
    state.dumpLoads[i].power = 0;
  }
  state.topTankTemp = 0;
  state.bottomTankTemp = 0;
  state.boilerOperating = false;
  state.boilerReceived = false;

  logDebug("Reset MQTT data due to disconnection");
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
    // Nothing follows this device, but the same setting carries its own two channels and
    // its status text, which is the only account of what the thermal dump did that can be
    // read from anywhere but the plant room. Tested for false, not for not-true: a
    // firmware without the key must not reboot on every start.
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
      return;
    }

    logDebug("MQTT configured, rebooting device...");
    Shelly.call("Shelly.Reboot", {});
  });

  return true;
}

function connectMqtt() {
  // Handlers and config first, unconditionally: the device's MQTT client is usually
  // connected before this script starts, and the config check used to sit behind that
  // early return, where it never ran at all.
  MQTT.setConnectHandler(handleMqttConnected);

  MQTT.setDisconnectHandler(function() {
    console.log("Disconnected from MQTT broker");
    state.mqttConnected = false;
    resetMqttData();

    if (state.keepaliveTimer) {
      Timer.clear(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
  });

  if (ensureMqttConfig()) {
    return; // reboot pending
  }

  // Check if MQTT is already connected
  let mqttStatus = Shelly.getComponentStatus("mqtt");
  if (mqttStatus && mqttStatus.connected === true) {
    logDebug("MQTT is already connected");
    if (!state.mqttConnected) {
      state.mqttConnected = true;
      // Set up subscriptions immediately since we're already connected
      setupMqttSubscriptionsAndKeepalive();
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
// Synchronously update input and output states from device
function updateInputState() {
  let inputStatus = Shelly.getComponentStatus("input:0");

  if (inputStatus && inputStatus.state !== undefined) {
    if (state.frostThermostatActive !== inputStatus.state) {
      state.frostThermostatActive = inputStatus.state;
      updateStatus("Frost thermostat changed");
    }
  } else {
    console.log("Warning: Could not get input status");
  }
}

function updateOutputStates() {
  // Initialize output states from device
  state.outputs.forEach(function(output) {
    let switchStatus = Shelly.getComponentStatus("switch:" + output.id);

    if (switchStatus && switchStatus.output !== undefined) {
      output.on = switchStatus.output;
      output.intended = switchStatus.output; // Initialize intended to match actual
      logDebug(output.name + " initial state: " + (output.on ? "ON" : "OFF"));
    } else {
      console.log("Warning: Could not get " + output.name + " status");
    }
  });
}

// ===== Output control logic =====
function turnOutputOn(outputId, reason) {
  let output = getOutput(outputId);
  logDebug("Attempting to turn " + output.name + " ON: " + reason);

  // Set intended state before making the RPC call
  output.intended = true;

  Shelly.call(
    "Switch.Set",
    { id: outputId, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning " + output.name + " on: " + error_message);
        return;
      }

      // Update actual state (defensive, in case event doesn't fire)
      output.on = true;
      output.onTime = Date.now();
      updateStatus(reason);
    }
  );
}

function turnOutputOff(outputId, reason) {
  let output = getOutput(outputId);

  // Check minimum run time
  let currentTime = Date.now();
  let timeElapsed = currentTime - output.onTime;
  if (timeElapsed < config.minRunTime) {
    logDebug("Not turning " + output.name + " off - minimum run time not elapsed (" +
            (timeElapsed / 1000).toFixed(0) + "s / " + (config.minRunTime / 1000) + "s)");
    return;
  }

  logDebug("Attempting to turn " + output.name + " OFF: " + reason);

  // Set intended state before making the RPC call
  output.intended = false;

  Shelly.call(
    "Switch.Set",
    { id: outputId, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning " + output.name + " off: " + error_message);
        return;
      }

      // Update actual state (defensive, in case event doesn't fire)
      output.on = false;
      updateStatus(reason);
    }
  );
}

function checkSystemState() {
  updateStatus("Monitoring");

  let fanCoil = getOutput(OUTPUT_FAN_COIL);
  let pump = getOutput(OUTPUT_PUMP);

  // PRIORITY 1: Frost thermostat
  // If frost thermostat is active, turn on BOTH outputs unconditionally
  if (state.frostThermostatActive) {
    if (!fanCoil.on) {
      turnOutputOn(OUTPUT_FAN_COIL, "FROST PROTECTION");
    }
    if (!pump.on) {
      turnOutputOn(OUTPUT_PUMP, "FROST PROTECTION");
    }
    return; // Skip other checks
  }

  // PRIORITY 2: Stop if the boiler is operating, or if we do not know whether it is.
  //
  // Dumping heat is a power system optimisation, and it is only worth doing while the
  // heating side is known not to want that heat. An unheard boiler state therefore counts
  // as a running one: the state arrives seconds after connecting, and burning wood to feed
  // a fan coil is the one outcome worth a few seconds of inhibition to avoid.
  if (state.boilerOperating || !state.boilerReceived) {
    let reason = state.boilerReceived ? "Boiler Operating" : "Boiler State Unknown";
    if (fanCoil.on) {
      turnOutputOff(OUTPUT_FAN_COIL, reason);
    }
    if (pump.on) {
      turnOutputOff(OUTPUT_PUMP, reason);
    }
    return; // Skip other checks
  }

  // PRIORITY 3: Stop if tank is not hot
  if (state.topTankTemp < config.thresholds.minTankTemp) {
    if (fanCoil.on) {
      turnOutputOff(OUTPUT_FAN_COIL, "Tank Below Temperature");
    }
    if (pump.on) {
      turnOutputOff(OUTPUT_PUMP, "Tank Below Temperature");
    }
    return;
  }

  // PRIORITY 4: Check if any thermal dump is needed (dump load is powered but inactive)
  let dumpLoadStalled = isDumpLoadStalled();

  if (!dumpLoadStalled) {
    if (fanCoil.on) {
      turnOutputOff(OUTPUT_FAN_COIL, "Monitoring");
    }
    if (pump.on) {
      turnOutputOff(OUTPUT_PUMP, "Monitoring");
    }
    return;
  }

  // PUMP LOGIC: At least one dump load is cut-out, stir the tank
  if (!pump.on) {
    turnOutputOn(OUTPUT_PUMP, "Stirring tank");
  }

  // FAN COIL LOGIC: Turn on if temp delta is low
  let tempDelta = state.topTankTemp - state.bottomTankTemp;

  if (tempDelta <= config.thresholds.maxTempDelta) {
    if (!fanCoil.on) {
      turnOutputOn(OUTPUT_FAN_COIL, "Dumping heat");
    }
  } else if (fanCoil.on) {
    turnOutputOff(OUTPUT_FAN_COIL, "Stirring tank");
  }
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
    checkSystemState();
  });

  // Initial check immediately
  checkSystemState();
}

// ===== Initialization =====
function initializeVirtualComponents() {
  logDebug("Initializing virtual components");

  let compId = config.virtualComponents;
  let keys = [
    "text:" + compId.status
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
