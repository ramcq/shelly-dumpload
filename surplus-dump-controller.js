// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Surplus Dump Load Controller for Shelly Pro 0/1-10V Dimmer
// Monitors Victron energy and controls four 2.69kW dump loads:
// - Local dimmer output (SSR controlled via 0-10V)
// - Two remote switches on Shelly Pro 2PM (via MQTT RPC)
// - One remote switch on Shelly Pro 1PM (via MQTT RPC)
//
// Algorithm: Available = Solar + DC Hydro - AC + Intended Dumps - EV Headroom
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

  // Remote dump load switches, in allocation order. Each entry carries its own device,
  // so the constant stages need not share a Shelly: immersions 1 and 2 are the two
  // channels of the Pro 2PM, immersion 4 is a Pro 1PM of its own. switchId is the
  // channel on that device and is not the position in this list.
  remoteSwitches: {
    switches: [
      { deviceId: "shellypro2pm-ec6260a03d70", switchId: 0, name: "Buffer Immersion 1" },
      { deviceId: "shellypro2pm-ec6260a03d70", switchId: 1, name: "Buffer Immersion 2" },
      { deviceId: "shellypro1pm-5c013b056870", switchId: 0, name: "Buffer Immersion 4" }
    ]
  },

  // Victron topics (will be prefixed with N/<portalId>/)
  victron: {
    solarPower: "system/0/Ac/PvOnOutput/L1/Power",           // AC-coupled generation (solar + AC hydro) (W)
    dcHydroPower: "dcsource/279/Dc/0/Power",                 // DC-coupled hydro turbine power (W)
    acConsumption: "system/0/Ac/ConsumptionOnOutput/L1/Power", // AC consumption (W)
    evChargerPower: "evcharger/40/Ac/Power",      // EV charger power (W)
    evChargerStatus: "evcharger/40/Status",       // EV charger status (2=Charging)
    evChargerMode: "evcharger/40/Mode",           // EV charger mode (0=Manual, 1=Auto, 2=Scheduled)
    batterySOC: "system/0/Dc/Battery/Soc",        // Battery SOC (%)
    vebusState: "vebus/276/State",                 // VE.Bus state (9=Inverting required for dump loads)
    inverterOutput: "vebus/276/Ac/Out/L1/P"       // VE.Bus inverter output power (W)
  },

  // What we actually subscribe to. A Shelly script may hold ten MQTT subscriptions and
  // no more — exceeding it throws "Too many subscriptions" and the script does not run —
  // so the three evcharger paths above are taken as one subtree instead of three
  // subscriptions. Messages are still matched against the exact paths in config.victron,
  // so the extra topics the subtree delivers are read and ignored.
  // Seven here, plus one per remote switch device, leaves one spare.
  victronSubscriptions: [
    "system/0/Ac/PvOnOutput/L1/Power",
    "dcsource/279/Dc/0/Power",
    "system/0/Ac/ConsumptionOnOutput/L1/Power",
    "evcharger/40/#",
    "system/0/Dc/Battery/Soc",
    "vebus/276/State",
    "vebus/276/Ac/Out/L1/P"
  ],

  // EVSE control
  evse: {
    maxHeadroom: 7360         // W - max headroom to reserve when EVSE is in auto mode (230V × 32A)
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
    minChangeTime: 10 * 60 * 1000,  // ms - minimum time between switch state changes (10 minutes)
    maxInverterContribution: 12000, // W - max power inverter can add from battery (12kW limit, leaves 2kW headroom for unexpected loads)
    emergencyInverterLimit: 13000   // W - emergency shutoff threshold for inverter output (fast-path protection)
  },

  // Timing settings
  checkInterval: 5 * 1000,    // 5 seconds in milliseconds

  // A yield, not a wait: MQTT.subscribe is only acted on once the script returns to the
  // main loop, so a republish asked for in the same breath is answered before anything is
  // listening. The length hardly matters - a millisecond would do - only that it lands on
  // a later turn of the loop.
  initialKeepaliveDelay: 1000,  // ms - after subscribing, before asking for a republish

  // How long to wait for every remote stage to report its status before controlling
  // anyway. Every stage is asked to republish on connect, so this is the floor under a
  // lost request rather than the way status normally arrives.
  statusSeedTimeout: 90 * 1000,

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
  dcHydroPower: 0,
  acConsumption: 0,
  evChargerPower: 0,
  evChargerStatus: 0,        // 0=Disconnected, 1=Connected, 2=Charging, 3=Charged
  evChargerMode: 0,          // 0=Manual, 1=Auto, 2=Scheduled
  batterySOC: 0,             // Battery state of charge (%)
  vebusState: 0,             // VE.Bus state (0=Off, 9=Inverting)
  vebusReceived: false,      // Whether that was published rather than assumed
  inverterOutput: 0,         // VE.Bus inverter output power (W)

  // Calculated values
  availablePower: 0,         // Available power for dump loads (after headroom reserves)
  intendedDumpPower: 0,      // Power we intend dump loads to consume

  // Remote switch states, built below from config.remoteSwitches.switches
  remoteSwitches: [],

  // When the first control pass ran without every stage having reported
  firstIncompleteCheck: 0,

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

// One state entry per configured stage, so the two lists cannot drift apart: every
// place that walks one of them indexes the other by the same position.
for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
  state.remoteSwitches.push({
    on: false,
    voltage: 0,
    power: 0,
    statusReceived: false,
    lastChangeTime: 0
  });
}

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

// Get VE.Bus state string
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
  let modePart = config.dryRun ? "[DRY-RUN] " : "";
  let socPart = "SOC:" + state.batterySOC.toFixed(0) + "%";
  let solarPart = " Solar:" + state.solarPower.toFixed(0) + "W";
  let dcHydroPart = state.dcHydroPower > 0 ? " DC Hydro:" + state.dcHydroPower.toFixed(0) + "W" : "";
  let availPart = " Avail:" + state.availablePower.toFixed(0) + "W";

  // "?" is not "Off": both suppress every stage, but one is the inverter and the other is
  // this controller never having been told, which would otherwise be diagnosed as a fault
  // on the inverter.
  let vePart = " VE:" +
    (state.vebusReceived ? getVebusStateString(state.vebusState) : "?");

  let evPart = "";
  if (state.evChargerStatus === 2) {
    evPart = " EV:Charging(" + getEvModeString(state.evChargerMode) + ")";
  } else if (state.evChargerStatus === 1) {
    evPart = " EV:Connected";
  }

  let dumpPower = getDumpLoadPower();
  let dumpPart = " Dump:" + dumpPower.toFixed(0) + "W";

  let loads = [];
  for (let i = 0; i < state.remoteSwitches.length; i++) {
    loads.push("S" + i + (state.remoteSwitches[i].on ? ":ON" : ":OFF"));
  }
  loads.push(state.localDimmer.on ? "Dim:" + state.localDimmer.brightness + "%" : "Dim:OFF");
  let loadsPart = " [" + loads.join(" ") + "]";

  let eventPart = event ? " - " + event : "";

  let statusMessage = modePart + socPart + solarPart + dcHydroPart + availPart + vePart + evPart + dumpPart + loadsPart + eventPart;

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

    // Check if this is a remote switch status message. The device wildcards also
    // deliver input, sys and wifi topics, so match the exact switch topic per stage
    // rather than a prefix.
    for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
      let sw = config.remoteSwitches.switches[i];

      if (topic !== sw.deviceId + "/status/switch:" + sw.switchId) {
        continue;
      }

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

      logDebug(sw.name + ": on=" + state.remoteSwitches[i].on +
              ", voltage=" + state.remoteSwitches[i].voltage + "V" +
              ", power=" + state.remoteSwitches[i].power + "W");
      return;
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

    // Update DC hydro power
    if (relativeTopic === config.victron.dcHydroPower) {
      state.dcHydroPower = parseFloat(payload.value);
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

    // Update VE.Bus state
    if (relativeTopic === config.victron.vebusState) {
      state.vebusState = parseInt(payload.value);
      logDebug("VE.Bus state updated: " + state.vebusState + " (" + getVebusStateString(state.vebusState) + ")");

      // Worth a console line rather than a debug one: until this arrives every stage is
      // suppressed, so this is the moment the controller becomes able to dump at all.
      if (!state.vebusReceived) {
        state.vebusReceived = true;
        console.log("VE.Bus state received: " + getVebusStateString(state.vebusState));
      }
    }

    // Update inverter output - with fast-path emergency suppression
    if (relativeTopic === config.victron.inverterOutput) {
      state.inverterOutput = parseFloat(payload.value);

      // Fast-path emergency suppression if inverter output exceeds safe limit
      if (state.initialized && state.inverterOutput > config.dumpLoad.emergencyInverterLimit) {
        logDebug("EMERGENCY: Inverter output " + state.inverterOutput.toFixed(0) +
                "W exceeds " + config.dumpLoad.emergencyInverterLimit + "W limit - suppressing all loads");
        suppressAllLoads("Inverter overload protection");
      }
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
  for (let i = 0; i < config.victronSubscriptions.length; i++) {
    let topic = topicPrefix + config.victronSubscriptions[i];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  // Subscribe to remote switch topics using one wildcard per device, so stages sharing
  // a device (immersions 1 and 2) still cost a single subscription. Subscriptions are a
  // scarce resource on Shelly, so de-duplicate rather than subscribing per stage.
  let subscribedDevices = [];
  for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
    let deviceId = config.remoteSwitches.switches[i].deviceId;

    if (arrayContains(subscribedDevices, deviceId)) {
      continue;
    }
    subscribedDevices.push(deviceId);

    let switchTopic = deviceId + "/status/+";
    MQTT.subscribe(switchTopic, processMqttMessage);
    logDebug("Subscribed to: " + switchTopic);
  }

  // Ask for a full republish, but from a later turn of the main loop than the subscriptions
  // above - see config.initialKeepaliveDelay.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestRemoteStatus();
  });

  // Setup periodic keepalive (every 30 seconds).
  //
  // Keep asking for a republish until the VE.Bus state has actually been seen, in case the
  // yield above was not enough. The broker publishes nothing until a value changes, and
  // this one changes only when a generator runs - months apart - so it is only ever seen in
  // a republish. Everything else in the topic set changes every few seconds and so arrives
  // regardless, which is what makes the miss invisible: the one path the Priority 1 gate
  // rests on is the one that fails to arrive.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.vebusReceived);
    requestRemoteStatus();
  });
}

// Shelly publishes status on change and does not retain it, so nothing arrives from a stage
// that has not moved since this script started. A PM channel cannot stay quiet for long -
// its power, voltage and energy readings drift, and one republishes every 20-30 seconds
// whether or not it has switched - but a stage that is off may say nothing at all, and until
// every stage has reported, this controller will not touch any of them.
//
// So ask, rather than wait it out: `status_update` on a device's command topic makes it
// republish every component on `<prefix>/status/…`, which the wildcard subscription above
// already covers. No extra subscription, no HTTP, no reply topic, and it needs only
// `enable_control`, which is on by default. Same shape as the keepalive, and for the same
// reason: ask on connect, then keep asking until the answer arrives, since the request is
// as losable as the answer.
//
// One ask per device, not per stage: immersions 1 and 2 share a Pro 2PM, and one republish
// carries both channels.
function requestRemoteStatus() {
  let asked = [];

  for (let i = 0; i < config.remoteSwitches.switches.length; i++) {
    let sw = config.remoteSwitches.switches[i];

    if (state.remoteSwitches[i].statusReceived || arrayContains(asked, sw.deviceId)) {
      continue;
    }
    asked.push(sw.deviceId);

    MQTT.publish(sw.deviceId + "/command", "status_update", 1, false);
    logDebug("Asked " + sw.deviceId + " to republish its status");
  }
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
  state.dcHydroPower = 0;
  state.acConsumption = 0;
  state.evChargerPower = 0;
  state.evChargerStatus = 0;
  state.evChargerMode = 0;
  state.batterySOC = 0;
  state.vebusState = 0; // Off
  state.vebusReceived = false;
  state.inverterOutput = 0;

  for (let i = 0; i < state.remoteSwitches.length; i++) {
    state.remoteSwitches[i].on = false;
    state.remoteSwitches[i].voltage = 0;
    state.remoteSwitches[i].power = 0;
    state.remoteSwitches[i].statusReceived = false;
  }

  // Re-arm the bounded wait, so a reconnect cannot leave us gated on a silent stage
  state.firstIncompleteCheck = 0;

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
    // This device's own light:0 is buffer immersion 3, and thermal-dump-controller.js
    // watches its published status for the cutout it cannot otherwise see. Status
    // notifications off means a stage that boils with nothing to recover it. Tested for
    // false, not for not-true: a firmware without the key must not reboot on every start.
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
// index is the position in config.remoteSwitches.switches; the channel actually
// commanded is that entry's switchId, on that entry's own device.
function sendRemoteSwitchCommand(index, turnOn, reason) {
  if (!state.mqttConnected) {
    logDebug("Cannot send RPC command: MQTT not connected");
    return;
  }

  let sw = config.remoteSwitches.switches[index];
  let rpcId = getNextRpcId();
  let payload = JSON.stringify({
    id: rpcId,
    src: "surplus_ctrl",
    method: "Switch.Set",
    params: {
      id: sw.switchId,
      on: turnOn
    }
  });

  logDebug("Sending RPC to " + sw.name + " (" + sw.deviceId +
          " switch:" + sw.switchId + "): " + (turnOn ? "ON" : "OFF") + " - " + reason);

  MQTT.publish(sw.deviceId + "/rpc", payload, 1, false);
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
function isEvChargingInAuto() {
  // Check if EV charger is actively charging in auto mode
  // Mode 1 = Auto, Status 2 = Charging
  return state.evChargerMode === 1 && state.evChargerStatus === 2;
}

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

  let available = state.solarPower + state.dcHydroPower - state.acConsumption + dumpPower;

  // EV charger in auto mode: reserve headroom to avoid fighting with its surplus control
  let evCharging = isEvChargingInAuto();
  if (evCharging) {
    let evHeadroom = Math.min(460, config.evse.maxHeadroom - state.evChargerPower);
    available -= evHeadroom;
    logDebug("EVSE auto mode active, reserving " + evHeadroom.toFixed(0) + "W headroom (2A margin)");
  }

  // Battery headroom: reserve power for parasitic loads + trickle charge
  // Skip during EV charging to absorb EVSE ampere-step surplus (prevents SOC drift 97%→98%)
  if (!evCharging) {
    available -= config.dumpLoad.batteryHeadroom;
  }

  state.availablePower = available;

  logDebug("Available power: " + state.availablePower.toFixed(0) + "W (using " +
          (useActualDumpPower ? "actual" : "intended") + " dump power: " +
          dumpPower.toFixed(0) + "W)");

  return state.availablePower;
}

// Calculate maximum safe dump power based on inverter discharge limit
// Returns the maximum power dumps can consume without exceeding inverter capacity
function calculateMaxDumpPower(useActualDumpPower) {
  // Calculate base house load (excluding dump loads to avoid feedback loop)
  let dumpPower = useActualDumpPower ? getDumpLoadPower() : state.intendedDumpPower;
  let baseLoad = state.acConsumption - dumpPower;

  // Calculate inverter contribution for base load only
  // Inverter contribution = base load minus AC-coupled generation (DC hydro goes through inverter)
  let baseInverterContribution = baseLoad - state.solarPower;

  // Calculate maximum dump power that keeps inverter within limit
  // Can be negative if base load already exceeds limit (will safely disable all loads)
  let maxDumpPower = config.dumpLoad.maxInverterContribution - baseInverterContribution;

  logDebug("Max dump calc: solar=" + state.solarPower.toFixed(0) + "W" +
          ", dcHydro=" + state.dcHydroPower.toFixed(0) + "W (DC, via inverter)" +
          ", acConsumption=" + state.acConsumption.toFixed(0) + "W" +
          ", dumpPower=" + dumpPower.toFixed(0) + "W (" + (useActualDumpPower ? "actual" : "intended") + ")" +
          ", baseLoad=" + baseLoad.toFixed(0) + "W" +
          ", baseInverterContrib=" + baseInverterContribution.toFixed(0) + "W" +
          ", maxDumpPower=" + maxDumpPower.toFixed(0) + "W" +
          ", limit=" + config.dumpLoad.maxInverterContribution + "W");

  return maxDumpPower;
}

function controlDumpLoads(dumpMax) {
  // Use actual dump power in dry-run (observing), intended when controlling (avoid feedback)
  let useActual = config.dryRun;

  let available;
  let reason;

  if (dumpMax) {
    // High SOC mode: run dumps up to inverter discharge limit
    available = calculateMaxDumpPower(useActual);
    reason = "High SOC (inverter-limited)";
  } else {
    // Normal mode: track surplus power
    available = calculateAvailablePower(useActual);
    reason = "Surplus control";
  }

  // Calculate desired state
  let desiredState = calculateDesiredState(available);

  // Apply the desired state
  applyDesiredState(desiredState, reason);
}

function calculateDesiredState(available) {
  let desired = {
    switches: [],  // Remote switches, one per configured stage
    dimmerOn: false,
    dimmerBrightness: 0,
    intendedPower: 0
  };

  for (let i = 0; i < state.remoteSwitches.length; i++) {
    desired.switches.push(false);
  }

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

  let allocation = [];
  for (let i = 0; i < desired.switches.length; i++) {
    allocation.push("Switch" + i + "=" + (desired.switches[i] ? "ON" : "OFF"));
  }

  logDebug("Allocation: " + allocation.join(", ") +
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
      // Every stage is asked to republish on connect, and an energised one announces
      // itself within half a minute regardless, so what is left here is a lost request to
      // a stage that is off and therefore silent. Waiting indefinitely on it would let one
      // idle stage hold every other load off, so bound the wait and then treat the silent
      // stages as off. Commanding a stage that is already in the desired position is a
      // no-op, so guessing wrong is cheap.
      if (state.firstIncompleteCheck === 0) {
        state.firstIncompleteCheck = Date.now();
      }

      if (Date.now() - state.firstIncompleteCheck < config.statusSeedTimeout) {
        logDebug("Waiting for initial remote switch status before controlling");
        updateStatus("Waiting for initial data");
        return;
      }

      console.log("Proceeding without status from every stage; assuming the silent ones are off");
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

  // PRIORITY 1: VE.Bus state check
  // Only allow dumps when inverter is in Inverting mode (state 9)
  // Covers: Off, Fault, Passthru (generator), Power Assist, Bulk/Absorption/Float (charging)
  if (state.vebusState !== 9) {
    // Not yet heard from suppresses exactly as Off does, but says so differently: the
    // republish retry above is what ends that, and it is not an inverter fault.
    let veName = state.vebusReceived ? getVebusStateString(state.vebusState) : "Unknown";
    logDebug("VE.Bus not inverting (" + veName + "), suppressing all dump loads");
    suppressAllLoads("VE.Bus " + veName);
    updateStatus("VE " + veName);
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

  // PRIORITY 3: EV auto mode - always use normal surplus control
  // When EV is in auto mode, it naturally manages surplus and prevents overcharge
  // Using max dumps would cause EV to reduce charging, creating oscillation
  if (isEvChargingInAuto()) {
    logDebug("EV in auto mode - using normal surplus control (SOC: " + state.batterySOC + "%)");
    controlDumpLoads(false);  // Normal mode with EV headroom reservation
    updateStatus("EV auto mode");
    return;
  }

  // PRIORITY 4: High SOC protection (overcharge) - only when no EV auto mode
  // Run dumps at maximum safe level (up to inverter discharge limit)
  if (state.batterySOC > config.soc.targetSOC) {
    logDebug("Battery SOC above target (" + state.batterySOC + "% > " +
            config.soc.targetSOC + "%), enabling dump loads with inverter limit");
    controlDumpLoads(true);  // Dump max mode - run up to inverter limit
    updateStatus("High SOC - Max dump");
    return;
  }

  // PRIORITY 5: Normal operation - control based on surplus
  controlDumpLoads(false);
  updateStatus("Monitoring");
}

function suppressAllLoads(reason) {
  let desired = {
    switches: [],
    dimmerOn: false,
    dimmerBrightness: 0,
    intendedPower: 0
  };

  for (let i = 0; i < state.remoteSwitches.length; i++) {
    desired.switches.push(false);
  }

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
