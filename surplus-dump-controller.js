// Surplus Dump Load Controller for Shelly Pro 0/1-10V Dimmer
// Monitors Victron energy and controls three 2.69kW dump loads:
// - Local dimmer output (SSR controlled via 0-10V)
// - Two remote switches on Shelly Pro 2PM (via MQTT RPC)
//
// Algorithm: Available = Solar - AC + Intended Dumps - EV Headroom
// Uses intended dump power (not actual) to avoid feedback loops
// Suppresses dumps if SOC < target or generator active

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794" // VRM portal ID
  },

  // Remote dump load switches (Shelly Pro 2PM)
  remoteSwitches: {
    switches: [
      { id: 0, name: "Pro 2PM Switch 0", statusTopic: "shellypro2pm-ec6260a03d70/status/switch:0" },
      { id: 1, name: "Pro 2PM Switch 1", statusTopic: "shellypro2pm-ec6260a03d70/status/switch:1" }
    ],
    rpcTopic: "shellypro2pm-ec6260a03d70/rpc"
  },

  // Victron topics (will be prefixed with N/<portalId>/)
  victron: {
    solarPower: "system/0/Ac/PvOnOutput/L1/Power",           // Total solar power (W)
    acConsumption: "system/0/Ac/ConsumptionOnOutput/L1/Power", // AC consumption (W)
    evChargerPower: "evcharger/40/Ac/Power",      // EV charger power (W)
    evChargerStatus: "evcharger/40/Status",       // EV charger status (2=Charging)
    evChargerMode: "evcharger/40/Mode",           // EV charger mode (0=Manual, 1=Auto, 2=Scheduled)
    batterySOC: "system/0/Dc/Battery/Soc",        // Battery SOC (%)
    acSource: "system/0/Ac/ActiveIn/Source"       // AC source (0=Unknown;1=Grid;2=Generator;3=Shore;240=Not connected)
  },

  // EVSE control
  evse: {
    maxHeadroom: 7000         // W - max headroom to reserve when EVSE is in auto mode
  },

  // SOC control
  soc: {
    targetSOC: 97             // % - disable dumps if SOC falls below this
  },

  // Dump load parameters
  dumpLoad: {
    heaterPower: 2690,        // W - nominal power per heater (2.69kW)
    minSurplus: 100,          // W - minimum surplus to turn on any load
    batteryHeadroom: 200,     // W - reserve for parasitic loads (Cerbo, BMS) + trickle charge
    minChangePercent: 2,      // % - minimum dimmer change to avoid sub-1% jitter
    minChangeTime: 10 * 60 * 1000  // ms - minimum time between switch state changes (10 minutes)
  },

  // Timing settings
  checkInterval: 5 * 1000,    // 5 seconds in milliseconds

  // Virtual component IDs (minimal to avoid MQTT spam)
  virtualComponents: {
    status: 200
  },

  // Debug and dry-run modes
  debugMode: true,
  dryRun: false              // If true, calculate but don't control loads
};

// ===== State variables =====
let state = {
  // MQTT connection
  mqttConnected: false,
  keepaliveTimer: null,

  // Initialization tracking
  initialized: false,        // True after first evaluation (prevents disrupting running loads)

  // Victron data
  solarPower: 0,
  acConsumption: 0,
  evChargerPower: 0,
  evChargerStatus: 0,        // 0=Disconnected, 1=Connected, 2=Charging, 3=Charged
  evChargerMode: 0,          // 0=Manual, 1=Auto, 2=Scheduled
  batterySOC: 0,             // Battery state of charge (%)
  acSource: 240,             // AC source (240 = not connected)

  // Calculated values
  availablePower: 0,         // Available power for dump loads (after headroom reserves)
  intendedDumpPower: 0,      // Power we intend dump loads to consume

  // Remote switch states
  remoteSwitches: [
    { on: false, voltage: 0, power: 0, statusReceived: false, lastChangeTime: 0 },
    { on: false, voltage: 0, power: 0, statusReceived: false, lastChangeTime: 0 }
  ],

  // Local dimmer state
  localDimmer: {
    on: false,
    brightness: 0,
    power: 0,
    voltage: 0,
    lastChangeTime: 0
  },

  // Control state
  rpcIdCounter: 0,

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
    console.log("[DEBUG-SURPLUS] " + message);
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

function getNextRpcId() {
  state.rpcIdCounter++;
  if (state.rpcIdCounter > 9999) {
    state.rpcIdCounter = 1;
  }
  return state.rpcIdCounter;
}

// Calculate total dump load power consumption
function getDumpLoadPower() {
  let total = 0;

  // Remote switches
  for (let i = 0; i < state.remoteSwitches.length; i++) {
    total += state.remoteSwitches[i].power;
  }

  // Local dimmer
  total += state.localDimmer.power;

  return total;
}

// Get AC source string
function getAcSourceString(source) {
  if (source === 0) return "Unknown";
  if (source === 1) return "Grid";
  if (source === 2) return "Generator";
  if (source === 3) return "Shore";
  if (source === 240) return "None";
  return "Unknown";
}

// Update the status display
function updateStatus(event) {
  let modePart = config.dryRun ? "[DRY-RUN] " : "";
  let socPart = "SOC:" + state.batterySOC.toFixed(0) + "%";
  let solarPart = " Solar:" + state.solarPower.toFixed(0) + "W";
  let availPart = " Avail:" + state.availablePower.toFixed(0) + "W";

  let acSourceStr = getAcSourceString(state.acSource);
  let acPart = " AC:" + acSourceStr;

  let evPart = "";
  if (state.evChargerStatus === 2) {
    evPart = " EV:Charging(" + getEvModeString(state.evChargerMode) + ")";
  } else if (state.evChargerStatus === 1) {
    evPart = " EV:Connected";
  }

  let dumpPower = getDumpLoadPower();
  let dumpPart = " Dump:" + dumpPower.toFixed(0) + "W";

  let sw0 = state.remoteSwitches[0].on ? "S0:ON" : "S0:OFF";
  let sw1 = state.remoteSwitches[1].on ? "S1:ON" : "S1:OFF";
  let dim = state.localDimmer.on ? "Dim:" + state.localDimmer.brightness + "%" : "Dim:OFF";
  let loadsPart = " [" + sw0 + " " + sw1 + " " + dim + "]";

  let eventPart = event ? " - " + event : "";

  let statusMessage = modePart + socPart + solarPart + availPart + acPart + evPart + dumpPart + loadsPart + eventPart;

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

  // Status display (minimal - only one component to avoid MQTT spam)
  if (!arrayContains(existingComponentKeys, "text:" + compId.status)) {
    console.log("Creating status component");
    Shelly.call("Virtual.Add", {
      type: "text",
      id: compId.status,
      config: {
        name: "Surplus Dump Status",
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

  console.log("=== Surplus Dump Load Controller Configuration ===");
  console.log("Heater Power: " + config.dumpLoad.heaterPower + "W per unit");
  console.log("Target SOC: " + config.soc.targetSOC + "%");
  console.log("Min Available: " + config.dumpLoad.minSurplus + "W");
  console.log("Battery Headroom: " + config.dumpLoad.batteryHeadroom + "W (parasitic + trickle)");
  console.log("Min Dimmer Change: " + config.dumpLoad.minChangePercent + "%");
  console.log("Min Switch Change Time: " + (config.dumpLoad.minChangeTime / (60 * 1000)) + " minutes");
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  console.log("EVCS Instance: " + config.victron.evChargerPower.split("/")[1]);
  if (config.dryRun) {
    console.log("*** DRY-RUN MODE: Will observe and log but NOT control loads ***");
  }
  console.log("==================================================");

  updateStatus("Monitoring started");
}

// ===== Status handlers =====
function setupEventHandlers() {
  logDebug("Setting up status handlers");

  // Watch for local light:0 status changes (avoids RPC re-entrancy)
  Shelly.addStatusHandler(function(event) {
    if (!event || event.component !== "light:0" || !event.delta)
      return;

    logDebug("Light status change: " + JSON.stringify(event.delta));

    if (event.delta.hasOwnProperty("output")) {
      state.localDimmer.on = Boolean(event.delta.output);
      logDebug("Local output: " + state.localDimmer.on);
    }
    if (event.delta.hasOwnProperty("brightness")) {
      state.localDimmer.brightness = parseFloat(event.delta.brightness);
      logDebug("Local brightness: " + state.localDimmer.brightness + "%");
    }
    if (event.delta.hasOwnProperty("voltage")) {
      state.localDimmer.voltage = parseFloat(event.delta.voltage);
      logDebug("Local voltage: " + state.localDimmer.voltage + "V");
    }
    if (event.delta.hasOwnProperty("apower")) {
      state.localDimmer.power = parseFloat(event.delta.apower);
      logDebug("Local power: " + state.localDimmer.power + "W");
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

    // Check if this is a remote switch status message
    for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
      if (topic === config.remoteSwitches.switches[i].statusTopic) {
        if (payload.output !== undefined) {
          state.remoteSwitches[i].on = Boolean(payload.output);
        }
        if (payload.voltage !== undefined) {
          state.remoteSwitches[i].voltage = parseFloat(payload.voltage);
        }
        if (payload.apower !== undefined) {
          state.remoteSwitches[i].power = parseFloat(payload.apower);
        }

        state.remoteSwitches[i].statusReceived = true;

        logDebug(config.remoteSwitches.switches[i].name + ": on=" + state.remoteSwitches[i].on +
                ", voltage=" + state.remoteSwitches[i].voltage + "V" +
                ", power=" + state.remoteSwitches[i].power + "W");
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

    // Update solar power
    if (relativeTopic === config.victron.solarPower) {
      state.solarPower = parseFloat(payload.value);
    }

    // Update AC consumption
    if (relativeTopic === config.victron.acConsumption) {
      state.acConsumption = parseFloat(payload.value);
    }

    // Update EV charger power
    if (relativeTopic === config.victron.evChargerPower) {
      state.evChargerPower = parseFloat(payload.value);
    }

    // Update EV charger status
    if (relativeTopic === config.victron.evChargerStatus) {
      state.evChargerStatus = parseInt(payload.value);
      logDebug("EV charger status updated: " + state.evChargerStatus +
              " (" + getEvStatusString(state.evChargerStatus) + ")");
    }

    // Update EV charger mode
    if (relativeTopic === config.victron.evChargerMode) {
      state.evChargerMode = parseInt(payload.value);
      logDebug("EV charger mode updated: " + state.evChargerMode +
              " (" + getEvModeString(state.evChargerMode) + ")");
    }

    // Update battery SOC
    if (relativeTopic === config.victron.batterySOC) {
      state.batterySOC = parseFloat(payload.value);
    }

    // Update AC source
    if (relativeTopic === config.victron.acSource) {
      state.acSource = parseInt(payload.value);
      logDebug("AC source updated: " + state.acSource + " (" + getAcSourceString(state.acSource) + ")");
    }
  } catch (e) {
    console.log("Error processing MQTT message: " + e.message);
  }
}

function getEvStatusString(status) {
  if (status === 0) return "Disconnected";
  if (status === 1) return "Connected";
  if (status === 2) return "Charging";
  if (status === 3) return "Charged";
  return "Unknown";
}

function getEvModeString(mode) {
  if (mode === 0) return "Manual";
  if (mode === 1) return "Auto";
  if (mode === 2) return "Scheduled";
  return "Unknown";
}

function setupMqttSubscriptionsAndKeepalive() {
  logDebug("Setting up MQTT subscriptions and keepalive");

  // Subscribe to Victron topics
  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.victron) {
    let topic = topicPrefix + config.victron[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  // Subscribe to remote switch topics
  for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
    MQTT.subscribe(config.remoteSwitches.switches[i].statusTopic, processMqttMessage);
    logDebug("Subscribed to: " + config.remoteSwitches.switches[i].statusTopic);
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
  state.solarPower = 0;
  state.acConsumption = 0;
  state.evChargerPower = 0;
  state.evChargerStatus = 0;
  state.evChargerMode = 0;
  state.batterySOC = 0;
  state.acSource = 240; // Not connected

  for (let i = 0; i < state.remoteSwitches.length; i++) {
    state.remoteSwitches[i].on = false;
    state.remoteSwitches[i].voltage = 0;
    state.remoteSwitches[i].power = 0;
    state.remoteSwitches[i].statusReceived = false;
  }

  logDebug("Reset MQTT data due to disconnection");
}

function connectMqtt() {
  // Always set up MQTT event handlers (before any early returns)
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
        return;
      }

      logDebug("MQTT configured, rebooting device...");
      Shelly.call("Shelly.Reboot", {});
    });
    return;
  }
}

// ===== Device state management =====
// Synchronously update local dimmer state from device
function updateLocalDimmerState() {
  let lightStatus = Shelly.getComponentStatus("light:0");

  if (lightStatus) {
    // Initialize all state fields from status
    state.localDimmer.on = lightStatus.output || false;
    state.localDimmer.brightness = lightStatus.brightness || 0;
    state.localDimmer.voltage = lightStatus.voltage || 0;
    state.localDimmer.power = lightStatus.apower || 0;

    logDebug("Initial light state: on=" + state.localDimmer.on +
            ", brightness=" + state.localDimmer.brightness + "%" +
            ", voltage=" + state.localDimmer.voltage + "V" +
            ", power=" + state.localDimmer.power + "W");
  } else {
    console.log("Warning: Could not get light status");
  }
}

// ===== Remote device control via MQTT RPC =====
function sendRemoteSwitchCommand(switchId, turnOn, reason) {
  if (!state.mqttConnected) {
    logDebug("Cannot send RPC command: MQTT not connected");
    return;
  }

  let rpcId = getNextRpcId();
  let payload = JSON.stringify({
    id: rpcId,
    src: "surplus_ctrl",
    method: "Switch.Set",
    params: {
      id: switchId,
      on: turnOn
    }
  });

  logDebug("Sending RPC to " + config.remoteSwitches.switches[switchId].name +
          ": " + (turnOn ? "ON" : "OFF") + " - " + reason);

  MQTT.publish(config.remoteSwitches.rpcTopic, payload, 1, false);
}

function setLocalDimmer(turnOn, brightness, reason) {
  logDebug("Setting local dimmer: " + (turnOn ? "ON" : "OFF") +
          " brightness=" + brightness + "% - " + reason);

  Shelly.call(
    "Light.Set",
    { id: 0, on: turnOn, brightness: brightness },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error setting light: " + error_message);
        return;
      }

      state.localDimmer.on = turnOn;
      state.localDimmer.brightness = brightness;
      updateStatus(reason);
    }
  );
}

// ===== Surplus calculation and control logic =====
function isLoadStalled(load, lastChangeTime) {
  // Detect thermal cutout: output ON, voltage present, but negligible power
  const minVoltage = 200;   // V - power is present
  const maxStallPower = 50; // W - allow small margin above 0
  const gracePeriod = 30000; // ms - don't check stalls on recently changed loads

  // Grace period: measurements lag behind commands, so newly-changed loads
  // appear stalled before power readings arrive. Wait for stable state.
  if (Date.now() - lastChangeTime < gracePeriod) {
    return false;
  }

  return load.on && load.voltage >= minVoltage && load.power <= maxStallPower;
}

function isLoadLocked(lastChangeTime) {
  // Check if load is within minimum change time window
  // Prevents rapid on/off cycling that causes relay wear and measurement instability
  if (lastChangeTime === 0) {
    return false;  // Never changed, not locked
  }

  let timeSinceChange = Date.now() - lastChangeTime;
  return timeSinceChange < config.dumpLoad.minChangeTime;
}

function shouldChangeDimmer(desired) {
  // Check if dimmer on/off state changed
  if (desired.dimmerOn !== state.localDimmer.on) {
    return true;
  }

  // If both on, check if brightness change exceeds minimum threshold
  if (desired.dimmerOn && state.localDimmer.on) {
    let brightnessDelta = Math.abs(desired.dimmerBrightness - state.localDimmer.brightness);
    return brightnessDelta >= config.dumpLoad.minChangePercent;
  }

  return false;
}

function calculateAvailablePower(useActualDumpPower) {
  // Choose between actual or intended dump power:
  // - Actual: when observing (dry-run, suppressing loads) - shows true available power
  // - Intended: when controlling - avoids feedback loops
  let dumpPower = useActualDumpPower ? getDumpLoadPower() : state.intendedDumpPower;

  let available = state.solarPower - state.acConsumption + dumpPower;

  // EV charger in auto mode: reserve headroom to avoid fighting with its surplus control
  if (state.evChargerMode === 1 && state.evChargerStatus === 2) {
    let evHeadroom = config.evse.maxHeadroom - state.evChargerPower;
    available -= evHeadroom;
    logDebug("EVSE auto mode active, reserving " + evHeadroom.toFixed(0) + "W headroom");
  }

  // Battery headroom: always reserve power for parasitic loads + trickle charge
  available -= config.dumpLoad.batteryHeadroom;

  state.availablePower = available;

  logDebug("Available power: " + state.availablePower.toFixed(0) + "W (using " +
          (useActualDumpPower ? "actual" : "intended") + " dump power: " +
          dumpPower.toFixed(0) + "W)");

  return state.availablePower;
}

function controlDumpLoads() {
  // Use actual dump power in dry-run (observing), intended when controlling (avoid feedback)
  let available = calculateAvailablePower(config.dryRun);

  // Calculate desired state
  let desiredState = calculateDesiredState(available);

  // Apply the desired state
  applyDesiredState(desiredState, "Surplus control");
}

function calculateDesiredState(available) {
  let desired = {
    switches: [false, false],  // Remote switches
    dimmerOn: false,
    dimmerBrightness: 0,
    intendedPower: 0
  };

  // If available power is below minimum, turn everything off
  if (available < config.dumpLoad.minSurplus) {
    logDebug("Available power below minimum, all loads OFF");
    return desired;
  }

  let heaterPower = config.dumpLoad.heaterPower;
  let remainingPower = available;
  let intendedPower = 0;

  // Allocate remote switches sequentially
  // Priority: stalled > locked > normal allocation
  // - Stalled: ON but not consuming budget (thermal cutout)
  // - Locked: can't change state, use nominal power if ON
  // - Normal: allocate based on available power
  for (let i = 0; i < state.remoteSwitches.length; i++) {
    let stalled = isLoadStalled(state.remoteSwitches[i], state.remoteSwitches[i].lastChangeTime);
    let locked = isLoadLocked(state.remoteSwitches[i].lastChangeTime);

    if (stalled) {
      // Stalled takes priority - load is ON but not consuming power
      desired.switches[i] = true;
      logDebug("Switch " + i + " stalled - keeping ON but not consuming budget");
    } else if (locked) {
      // Load is locked - keep current state
      desired.switches[i] = state.remoteSwitches[i].on;

      if (state.remoteSwitches[i].on) {
        // Locked ON - consume budget (nominal power)
        remainingPower -= heaterPower;
        intendedPower += heaterPower;
        logDebug("Switch " + i + " locked ON, consuming " + heaterPower + "W from budget");
      } else {
        // Locked OFF - skip allocation, next switch gets the power
        logDebug("Switch " + i + " locked OFF, skipping allocation");
      }
    } else {
      // Normal allocation
      if (remainingPower >= heaterPower) {
        desired.switches[i] = true;
        remainingPower -= heaterPower;
        intendedPower += heaterPower;
      }
    }
  }

  // Allocate Dimmer (variable, up to 100%)
  // Use floor() to bias toward slightly lower dump (trickle charge battery)
  let dimmerPercent = Math.min(100, (remainingPower / heaterPower) * 100);
  if (dimmerPercent >= config.dumpLoad.minChangePercent) {
    desired.dimmerOn = true;
    desired.dimmerBrightness = Math.floor(dimmerPercent);
    if (!isLoadStalled(state.localDimmer, state.localDimmer.lastChangeTime)) {
      intendedPower += (desired.dimmerBrightness / 100) * heaterPower;
    } else {
      logDebug("Dimmer stalled - keeping ON but not consuming budget");
    }
  }

  desired.intendedPower = intendedPower;

  logDebug("Allocation: Switch0=" + (desired.switches[0] ? "ON" : "OFF") +
          ", Switch1=" + (desired.switches[1] ? "ON" : "OFF") +
          ", Dimmer=" + (desired.dimmerOn ? desired.dimmerBrightness + "%" : "OFF") +
          ", intended=" + intendedPower.toFixed(0) + "W" +
          ", unused=" + Math.max(0, remainingPower - (dimmerPercent/100 * heaterPower)).toFixed(0) + "W");

  return desired;
}

function applyDesiredState(desired, reason) {
  let actualDumpPower = getDumpLoadPower();
  let previousIntended = state.intendedDumpPower;

  // Update intended dump power (for next calculation cycle)
  state.intendedDumpPower = desired.intendedPower;

  // Log the power flow: previous intended -> new intended, and compare to actual
  logDebug("Dump power: actual=" + actualDumpPower.toFixed(0) + "W, " +
          "intended(prev)=" + previousIntended.toFixed(0) + "W -> " +
          "intended(new)=" + desired.intendedPower.toFixed(0) + "W");

  // DRY-RUN MODE: Log what we would do but don't actually control
  if (config.dryRun) {
    let changes = [];

    for (let i = 0; i < state.remoteSwitches.length; i++) {
      if (desired.switches[i] !== state.remoteSwitches[i].on) {
        changes.push("Switch" + i + " -> " + (desired.switches[i] ? "ON" : "OFF"));
      }
    }

    if (shouldChangeDimmer(desired)) {
      if (desired.dimmerOn) {
        changes.push("Dimmer -> " + desired.dimmerBrightness + "%");
      } else {
        changes.push("Dimmer -> OFF");
      }
    }

    if (changes.length > 0) {
      console.log("[DRY-RUN] Would change: " + changes.join(", ") + " (" + reason + ")");
    }

    return;  // Don't actually control in dry-run mode
  }

  // NORMAL MODE: Actually control the loads
  // Control remote switches
  for (let i = 0; i < state.remoteSwitches.length; i++) {
    if (desired.switches[i] !== state.remoteSwitches[i].on) {
      sendRemoteSwitchCommand(i, desired.switches[i], reason);
      state.remoteSwitches[i].lastChangeTime = Date.now();
    }
  }

  // Control Dimmer
  if (shouldChangeDimmer(desired)) {
    setLocalDimmer(desired.dimmerOn, desired.dimmerBrightness, reason);
    state.localDimmer.lastChangeTime = Date.now();
  }
}

function checkSystemState() {
  // INITIALIZATION: Wait for all switch statuses, then initialize intended power
  if (!state.initialized) {
    // Check if all switch statuses received
    let allSwitchStatusReceived = true;
    for (let i = 0; i < state.remoteSwitches.length; i++) {
      if (!state.remoteSwitches[i].statusReceived) {
        allSwitchStatusReceived = false;
        break;
      }
    }

    if (!allSwitchStatusReceived) {
      logDebug("Waiting for initial remote switch status before controlling");
      updateStatus("Waiting for initial data");
      return;
    }

    // We have all statuses - initialize intended power to match actual state
    // This prevents disrupting loads that are already running
    state.initialized = true;
    let actualPower = getDumpLoadPower();
    if (actualPower > 0) {
      state.intendedDumpPower = actualPower;
      console.log("Initialized intended dump power to actual: " + actualPower.toFixed(0) + "W");
    }
  }

  // PRIORITY 1: Generator suppression
  // If generator (or any AC source other than "not connected") is active, turn off all loads
  if (state.acSource !== 240) {
    logDebug("AC source active (" + getAcSourceString(state.acSource) + "), suppressing all dump loads");
    suppressAllLoads("Generator/AC active");
    updateStatus("Generator active");
    return;
  }

  // PRIORITY 2: Low SOC protection
  if (state.batterySOC > 0 && state.batterySOC < config.soc.targetSOC) {
    logDebug("Battery SOC below target (" + state.batterySOC + "% < " +
            config.soc.targetSOC + "%), suppressing loads");
    suppressAllLoads("Low SOC");
    updateStatus("Low SOC");
    return;
  }

  // PRIORITY 3: High SOC protection (overcharge)
  if (state.batterySOC > config.soc.targetSOC) {
    logDebug("Battery SOC above target (" + state.batterySOC + "% > " +
            config.soc.targetSOC + "%), forcing maximum dump");
    forceMaxDumps("High SOC");
    updateStatus("High SOC - Max dump");
    return;
  }

  // PRIORITY 4: Normal operation - control based on surplus
  controlDumpLoads();

  // Update status display with current values (after control logic)
  updateStatus("Monitoring");
}

function suppressAllLoads(reason) {
  let desired = {
    switches: [false, false],
    dimmerOn: false,
    dimmerBrightness: 0,
    intendedPower: 0
  };

  applyDesiredState(desired, reason);
}

function forceMaxDumps(reason) {
  let desired = {
    switches: [true, true],
    dimmerOn: true,
    dimmerBrightness: 100,
    intendedPower: config.dumpLoad.heaterPower * 3  // All loads at max
  };

  applyDesiredState(desired, reason);
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
  console.log("Surplus Dump Load Controller Script starting");

  // Initial state update
  updateLocalDimmerState();

  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
