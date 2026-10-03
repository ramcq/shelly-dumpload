// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// DHW Controller for Shelly 1 Mini Gen3 - DHW Enable (192.168.1.123)
// Permits heat to move from the buffer into the cylinders; their stats decide whether any does.
//
// Ladder, first match wins:
//   1. The time clock, on this relay's own input, unconditionally
//   2. A shortage DHW window: one hour in six, guarded on buffer temperature
//
// Rules and reasoning in CONTROLS.md#dhw.

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000 // ms to wait before reconnection attempt
  },

  // The only device this script acts on; anywhere else it does nothing.
  device: {
    id: "48f6ee8e8780",
    name: "DHW Enable"
  },

  // The heat pump lock (.209): closed means the heat pump runs, open means shortage.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // The shortage DHW window. See CONTROLS.md#dhw.
  window: {
    slotHours: ["05", "11", "17", "23"], // Local hours, as sys.time writes them
    entryWindowLength: 60 * 60 * 1000,   // ms; the window on entering shortage
    minBufferTemp: 60                    // degC; the higher of buffer top and boiler flow
  },

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    bufferTop: "temperature/100/Temperature",  // Buffer top, from dbus-froeling
    boilerFlow: "temperature/103/Temperature", // Fröling register 30001, Kesseltemperatur

    // dbus-froeling holds its last value and sets /Connected to 0 when Modbus drops.
    froelingConnected: "temperature/100/Connected"
  },

  // Virtual component IDs
  virtualComponents: {
    status: 200
  },

  initialKeepaliveDelay: 1000,  // ms after subscribing before asking for a republish
  startupGrace: 5 * 60 * 1000,  // ms a relay found closed waits for the readings
  checkInterval: 30 * 1000, // 30 seconds in milliseconds

  // Debug mode
  debugMode: true
};

// ===== State variables =====
let state = {
  // MQTT connection state
  mqttConnected: false,
  keepaliveTimer: null,
  reconnectTimer: null,

  // Uptime in ms (see docs/adr/0003)
  nowUptime: null,
  startedAtUptime: null,
  listeningSinceUptime: null,  // Last connect; the grace for readings runs from here

  // Device identity
  identityKnown: false,
  deviceName: "",

  // Relay control state
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // State last commanded
  inputIsActive: false,      // The DHW time clock

  // The heat pump lock. Kept across a broker drop.
  lockIsClosed: false,
  lockKnown: false,

  bufferTop: 0,
  bufferTopReceived: false,
  boilerFlow: 0,
  boilerFlowReceived: false,

  bridgeConnected: true,
  bridgeConnectedReceived: false,

  windowKey: "",             // "05:00" etc., "entry", or "" for none
  windowBlind: false,        // Latched unguarded, with no buffer reading
  windowLatched: false,      // Guard passed; holds until the window ends
  entryWindowUntilUptime: null,  // Uptime the entry window ends at

  // Timer
  timerId: null
};

// ===== Elapsed time =====
function refreshUptime() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || sys.uptime === undefined) {
    return;
  }

  state.nowUptime = sys.uptime * 1000;

  if (state.startedAtUptime === null) {
    state.startedAtUptime = state.nowUptime;
  }
}

refreshUptime();
state.listeningSinceUptime = state.startedAtUptime;

// True until the grace from `sinceUptime` has run out, or while uptime has never been read.
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
    console.log("[DEBUG-DHW] " + message);
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

// The local hour as text ("05"), or "" without a synchronised clock.
function localHourText() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || !sys.time || !sys.last_sync_ts) {
    return "";
  }

  return sys.time.substring(0, 2);
}

function determineDeviceIdentity() {
  let info = Shelly.getDeviceInfo();

  logDebug("Device ID: " + info.id);

  if (info.id.indexOf(config.device.id) < 0) {
    console.log("Device " + info.id + " is not " + config.device.name + " - doing nothing");
    return false;
  }

  state.deviceName = config.device.name;
  state.identityKnown = true;
  return true;
}

// ===== The window =====

function bridgeIsDown() {
  return state.bridgeConnectedReceived && !state.bridgeConnected;
}

// The higher of buffer top and boiler flow, or null if neither is readable.
function guardTemperature() {
  if (bridgeIsDown()) {
    return null;
  }

  let hottest = null;

  if (state.bufferTopReceived) {
    hottest = state.bufferTop;
  }

  if (state.boilerFlowReceived && (hottest === null || state.boilerFlow > hottest)) {
    hottest = state.boilerFlow;
  }

  return hottest;
}

function guardSatisfied() {
  let hottest = guardTemperature();

  return hottest !== null && hottest >= config.window.minBufferTemp;
}

// True at once if the bridge is down; with no reading, only once the grace has run out.
function bufferUnreadable() {
  if (bridgeIsDown()) {
    return true;
  }

  if (guardTemperature() !== null) {
    return false;
  }

  return !withinGrace(state.listeningSinceUptime);
}

// The window now in effect, or "". A scheduled slot outranks the entry window.
function currentWindowKey() {
  if (!state.lockKnown || state.lockIsClosed) {
    return "";
  }

  let hour = localHourText();

  if (hour !== "" && arrayContains(config.window.slotHours, hour)) {
    return hour + ":00";
  }

  if (state.entryWindowUntilUptime !== null &&
      state.nowUptime < state.entryWindowUntilUptime) {
    return "entry";
  }

  return "";
}

function updateWindow() {
  let key = currentWindowKey();

  if (key === state.windowKey) {
    return;
  }

  if (key === "") {
    console.log("Shortage DHW window " + state.windowKey + " ended");
    state.windowKey = "";
    state.windowLatched = false;
    state.windowBlind = false;
    return;
  }

  // The latch carries over: windows that touch are one.
  console.log("Shortage DHW window " + key + " open" +
             (state.windowLatched ? " (continuing)" : ""));
  state.windowKey = key;
}

// Latch the window once the guard passes, at any point in it. Called only from the poll.
function updateWindowGuard() {
  if (state.windowKey === "" || state.windowLatched) {
    return;
  }

  if (guardSatisfied()) {
    state.windowLatched = true;
    state.windowBlind = false;
    console.log("Shortage DHW window " + state.windowKey + " guarded at " +
               guardTemperature().toFixed(1) + " degC - the buffer has something to give");
    return;
  }

  // No buffer reading: run unguarded, still bounded by the window. See CONTROLS.md#dhw.
  if (bufferUnreadable()) {
    state.windowLatched = true;
    state.windowBlind = true;
    console.log("Shortage DHW window " + state.windowKey +
               " running blind - no buffer reading");
  }
}

function windowOpen() {
  return state.windowKey !== "" && state.windowLatched;
}

// The ladder. The clock is first: a Switch.Set overrides `follow` until the next input edge.
function enableReason() {
  if (state.inputIsActive) {
    return "time clock";
  }

  if (windowOpen()) {
    return "shortage DHW window (" + state.windowKey +
           (state.windowBlind ? ", blind" : "") + ")";
  }

  return "";
}

// ===== Status =====
function updateStatus(event) {
  let relayPart = state.deviceName + (state.relayIsOn ? " ON" : " OFF");

  let lockPart = ", HP " + (!state.lockKnown
    ? "?"
    : (state.lockIsClosed ? "Enabled" : "Locked"));

  // "?" while the bridge is down.
  let blindBridge = bridgeIsDown();
  let bufferPart = ", Buffer " + ((!state.bufferTopReceived || blindBridge)
    ? "?"
    : state.bufferTop.toFixed(1) + "C");
  let flowPart = ", Flow " + ((!state.boilerFlowReceived || blindBridge)
    ? "?"
    : state.boilerFlow.toFixed(1) + "C");
  let bridgePart = blindBridge ? ", Fröling unreadable" : "";

  let clockPart = ", Clock " + (state.inputIsActive ? "ON" : "OFF");

  let windowPart = ", Window " + (state.windowKey === ""
    ? "-"
    : state.windowKey + (state.windowLatched ? " held" : " waiting") +
      (state.windowBlind ? " (blind)" : ""));

  let reason = enableReason();
  let enabledPart = reason !== "" ? ", Enabled: " + reason : "";

  let eventPart = event ? ": " + event : "";

  let statusMessage = relayPart + lockPart + bufferPart + flowPart + bridgePart +
                      clockPart + windowPart + enabledPart + eventPart;

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

  try {
    handles.status = Virtual.getHandle("text:" + compId.status);
  } catch (e) {
    console.log("Error getting component handles: " + e.message);
  }

  setupEventHandlers();
  connectMqtt();
  startMonitoring();

  let slots = [];
  for (let i = 0; i < config.window.slotHours.length; i++) {
    slots.push(config.window.slotHours[i] + ":00");
  }

  console.log("=== DHW Controller Configuration ===");
  console.log("Device: " + state.deviceName);
  console.log("The time clock closes the enable unconditionally, on this relay's input");
  console.log("Shortage DHW windows: " + slots.join(", ") +
             ", plus one on entering shortage");
  console.log("Window guard: buffer top or boiler flow at or above " +
             config.window.minBufferTemp + " degC");
  console.log("Heat Pump Lock Monitoring: " + config.heatPumpLock.statusTopic);
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  console.log("===================================");

  updateStatus("Monitoring started");
}

// ===== Event handlers =====
function setupEventHandlers() {
  logDebug("Setting up event handlers");

  Shelly.addEventHandler(function(event) {
    if (!event || !event.name || !event.info || !event.info.event)
      return;

    let isRelevantEvent = false;
    if (event.name === "switch" && event.info.event === "toggle") {
      isRelevantEvent = true;
    } else if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      isRelevantEvent = true;
    }

    if (!isRelevantEvent) {
      return;
    }

    logDebug("Event received: " + JSON.stringify(event));

    if (event.name === "switch" && event.info.event === "toggle") {
      let newState = event.info.state;

      if (newState === state.intendedRelayOn) {
        state.relayIsOn = newState;
        logDebug("Relay state changed as expected to: " + newState);
        return;
      }

      state.relayIsOn = newState;
      state.intendedRelayOn = newState;
      logDebug("Relay state changed externally to: " + newState);
      checkSystemState();
    }

    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      state.inputIsActive = event.info.state;
      console.log("DHW time clock " + (state.inputIsActive ? "calling" : "off"));
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

  refreshUptime();

  try {
    // The heat pump lock; its opening edge starts the entry window.
    if (topic === config.heatPumpLock.statusTopic) {
      let payload = JSON.parse(message);
      if (payload.output !== undefined) {
        let wasClosed = state.lockIsClosed;
        let wasKnown = state.lockKnown;
        state.lockIsClosed = Boolean(payload.output);
        state.lockKnown = true;

        if (!wasKnown || wasClosed !== state.lockIsClosed) {
          console.log("Heat pump lock " +
                     (state.lockIsClosed ? "closed - no shortage" : "open - SHORTAGE"));

          // Edges only: .209 republishes its status on every reconnect.
          if (!state.lockIsClosed) {
            state.entryWindowUntilUptime = state.nowUptime + config.window.entryWindowLength;
            console.log("Opening a DHW window for the next hour");
          }

          updateWindow();
          updateStatus("Heat pump lock changed");
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

    if (relativeTopic === config.topics.bufferTop) {
      state.bufferTop = parseFloat(payload.value);
      state.bufferTopReceived = true;
    }

    if (relativeTopic === config.topics.boilerFlow) {
      state.boilerFlow = parseFloat(payload.value);
      state.boilerFlowReceived = true;
    }

    // Not acted on here: see bridgeIsDown().
    if (relativeTopic === config.topics.froelingConnected) {
      let wasConnected = state.bridgeConnected;
      let wasKnown = state.bridgeConnectedReceived;
      state.bridgeConnected = (parseInt(payload.value) === 1);
      state.bridgeConnectedReceived = true;

      if (!wasKnown || wasConnected !== state.bridgeConnected) {
        console.log("Fröling bridge " + (state.bridgeConnected
          ? "reading the boiler again"
          : "cannot read the boiler - the buffer temperatures are held, not live"));
      }
    }
  } catch (e) {
    console.log("Error processing MQTT message: " + e.message);
  }
}

function handleMqttConnected() {
  console.log("Connected to MQTT broker");
  state.mqttConnected = true;

  refreshUptime();
  state.listeningSinceUptime = state.nowUptime;

  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.topics) {
    let topic = topicPrefix + config.topics[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  MQTT.subscribe(config.heatPumpLock.statusTopic, processMqttMessage);
  logDebug("Subscribed to the heat pump lock: " + config.heatPumpLock.statusTopic);

  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
  });

  // Victron publishes only on change: ask for a republish until every reading has arrived.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.bufferTopReceived && state.boilerFlowReceived &&
                  state.bridgeConnectedReceived);
    requestFollowedStatus(false);
  });
}

// Shelly status is not retained, so ask for it. See README, Seeding State From Other Devices.
function requestFollowedStatus(force) {
  if (force || !state.lockKnown) {
    MQTT.publish(config.heatPumpLock.commandTopic, "status_update", 1, false);
    logDebug("Asked the heat pump lock to republish: " + config.heatPumpLock.commandTopic);
  }
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

// Clears the buffer readings; keeps the lock.
function resetMqttData() {
  state.bufferTop = 0;
  state.bufferTopReceived = false;
  state.boilerFlow = 0;
  state.boilerFlowReceived = false;

  state.bridgeConnected = true;
  state.bridgeConnectedReceived = false;

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

// Returns true if a reconfigure, and so a reboot, is under way.
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
    // .164 reads this input. Tested for false, so firmware without the key doesn't reboot.
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
  if (state.reconnectTimer) {
    Timer.clear(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  // Handlers and config first: MQTT is usually connected before this script starts.
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
function updateDeviceState() {
  let switchStatus = Shelly.getComponentStatus("switch:0");
  if (switchStatus && switchStatus.output !== undefined) {
    if (state.relayIsOn !== switchStatus.output) {
      state.relayIsOn = switchStatus.output;
      state.intendedRelayOn = switchStatus.output;
      logDebug("Relay state synced: " + state.relayIsOn);
    }
  }

  let inputStatus = Shelly.getComponentStatus("input:0");
  if (inputStatus && inputStatus.state !== undefined) {
    if (state.inputIsActive !== inputStatus.state) {
      state.inputIsActive = inputStatus.state;
      logDebug("DHW time clock synced from local input: " + state.inputIsActive);
    }
  }
}

// ===== Relay control =====
function turnRelayOn(reason) {
  logDebug("Attempting to close the DHW enable: " + reason);

  state.intendedRelayOn = true;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error closing the DHW enable: " + error_message);
        state.intendedRelayOn = state.relayIsOn;
        return;
      }

      state.relayIsOn = true;
      console.log("DHW enabled: " + reason);
      updateStatus(reason);
    }
  );
}

function turnRelayOff(reason) {
  logDebug("Attempting to open the DHW enable: " + reason);

  state.intendedRelayOn = false;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error opening the DHW enable: " + error_message);
        state.intendedRelayOn = state.relayIsOn;
        return;
      }

      state.relayIsOn = false;
      console.log("DHW enable opened: " + reason);
      updateStatus(reason);
    }
  );
}

// Readings never received that could justify a closed relay.
function outstandingReadings() {
  let missing = [];

  if (!state.lockKnown) {
    missing.push("the heat pump lock");
  }
  if (!state.bufferTopReceived) {
    missing.push("the buffer top");
  }
  if (!state.boilerFlowReceived) {
    missing.push("the boiler flow");
  }

  return missing.join(", ");
}

function checkSystemState() {
  refreshUptime();

  updateWindow();
  updateWindowGuard();
  updateStatus("Monitoring");

  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  let reason = enableReason();

  // Not re-commanded: a Switch.Set overrides `follow` until the next input edge.
  if (reason !== "") {
    if (!state.relayIsOn) {
      turnRelayOn(reason);
    }
    return;
  }

  if (!state.relayIsOn) {
    return;
  }

  // A relay found closed waits out the startup grace for its readings.
  let outstanding = outstandingReadings();

  if (outstanding !== "" && withinStartupGrace()) {
    logDebug("Enabled, and still waiting on " + outstanding + " - leaving the relay alone");
    return;
  }

  turnRelayOff("Nothing is asking for hot water");
}

function checkStatus() {
  updateDeviceState();
  checkSystemState();
}

function startMonitoring() {
  logDebug("Starting monitoring with interval: " + (config.checkInterval / 1000) + " seconds");

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
  console.log("DHW Controller starting");

  updateDeviceState();

  if (!determineDeviceIdentity()) {
    return;
  }

  initializeVirtualComponents();
}

// Run initialization
init();
