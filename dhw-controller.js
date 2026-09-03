// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// DHW Controller for Shelly 1 Mini Gen3 - DHW Enable (192.168.1.123)
// Permits heat to move from the buffer into the cylinders. The cylinder stats decide whether
// any actually does, so nothing here senses cylinder temperature.
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

  // .164 is next door and its relay looks identical, so an unrecognised device runs nothing.
  device: {
    id: "48f6ee8e8780",
    name: "DHW Enable"
  },

  // Closed means the heat pump is running, open means shortage. Followed rather than
  // derived - see ADR 0001.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // The shortage DHW window: when the controller may close the enable in place of the time
  // clock, and what has to be true of the buffer before it does.
  window: {
    // Local time, as sys.time reports the hour: two characters, leading zero and all.
    slotHours: ["05", "11", "17", "23"],

    // The window on entering shortage. An interval, so it needs no synchronised clock.
    entryWindowLength: 60 * 60 * 1000,

    // A window on a cold buffer strips heat back out of the cylinders. Buffer top or boiler
    // flow, whichever is higher.
    minBufferTemp: 60
  },

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    bufferTop: "temperature/100/Temperature",  // Buffer top, from dbus-froeling
    boilerFlow: "temperature/103/Temperature", // Fröling register 30001, Kesseltemperatur

    // The bridge holds its last temperature when modbus drops, so a held reading keeps
    // arriving and keeps looking fresh; this is the only thing that says otherwise. One path
    // for both, since all four of its services fail together.
    froelingConnected: "temperature/100/Connected"
  },

  // Virtual component IDs
  virtualComponents: {
    status: 200
  },

  // A yield, not a wait: MQTT.subscribe is only acted on once the script returns to the
  // main loop, so a republish asked for in the same breath is answered before anything is
  // listening. The length hardly matters - a millisecond would do.
  initialKeepaliveDelay: 1000,
  startupGrace: 3 * 60 * 1000,  // ms - how long a relay found closed waits for the readings
                                // that might justify it before silence is taken at face
                                // value. Covers a Cerbo boot
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

  // Device identity
  startedAt: Date.now(),
  listeningSince: Date.now(),  // Script start, and every reconnect after it: a drop empties
                               // the readings as thoroughly as a restart does
  identityKnown: false,      // Whether this is the device the file is written for
  deviceName: "",

  // Relay control state
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // Intended relay state (prevents re-entrancy)
  inputIsActive: false,      // The DHW time clock, on this relay's own input

  // The heat pump lock, as published by .209. Kept across a broker drop: silence is not
  // .209 saying the battery recovered.
  lockIsClosed: false,       // Closed means the heat pump is running: no shortage
  lockKnown: false,          // Never having heard opens no window

  bufferTop: 0,
  bufferTopReceived: false,
  boilerFlow: 0,
  boilerFlowReceived: false,

  bridgeConnected: true,     // Absent, no claim either way
  bridgeConnectedReceived: false,

  windowKey: "",             // Which window is open: the hour it starts, or "entry"
  windowBlind: false,        // Whether it latched with no buffer reading behind it
  windowLatched: false,      // The enable has closed within this window, so it stays closed
                             // until the window ends
  entryWindowUntil: 0,       // ms, Date.now() - an interval within this run, not a time

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

// The local hour as sys.time writes it - "05", "17" - or "" where there is no synchronised
// clock, which leaves no scheduled slots. Compared as text, so nothing has to decide what
// "08" is worth.
function localHourText() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || !sys.time || !sys.last_sync_ts) {
    return "";
  }

  return sys.time.substring(0, 2);
}

// An unrecognised device runs nothing, leaving the time clock passing through in hardware.
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

// Never having heard is not a claim either way.
function bridgeIsDown() {
  return state.bridgeConnectedReceived && !state.bridgeConnected;
}

// The hotter of the two, or null where there is none to be had. Zero is a reading nobody
// sent, and a value the bridge is holding over a dead link is not a reading either.
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

// Being told is immediate; silence waits out the grace, since a controller that has just
// connected has readings still in flight - .164 answers a directed request well before the
// Cerbo's republish arrives.
function bufferUnreadable() {
  if (bridgeIsDown()) {
    return true;
  }

  if (guardTemperature() !== null) {
    return false;
  }

  return Date.now() - state.listeningSince >= config.startupGrace;
}

// Which window this moment falls in, or "" for none. A scheduled slot outranks the entry
// window, so two overlapping report one key rather than alternating.
function currentWindowKey() {
  if (!state.lockKnown || state.lockIsClosed) {
    return "";
  }

  let hour = localHourText();

  if (hour !== "" && arrayContains(config.window.slotHours, hour)) {
    return hour + ":00";
  }

  if (state.entryWindowUntil && Date.now() < state.entryWindowUntil) {
    return "entry";
  }

  return "";
}

// Move the latch to the window this moment is in, before the ladder reads it.
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

  // The latch carries across a change of key, because it is cleared whenever there is no
  // window at all: still set here means the two windows touch and are one.
  console.log("Shortage DHW window " + key + " open" +
             (state.windowLatched ? " (continuing)" : ""));
  state.windowKey = key;
}

// The guard, checked throughout the hour rather than at the top of it, and latched once it
// passes. Runs after updateWindow() and only from the poll, so the check that sets the latch
// is the check that closes the enable.
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

  // Make hot water anyway: in shortage the buffer is the only route to it, and .164
  // releases the boiler on the same shortage. The slots still bound it.
  if (bufferUnreadable()) {
    state.windowLatched = true;
    state.windowBlind = true;
    console.log("Shortage DHW window " + state.windowKey +
               " running blind - no buffer reading");
  }
}

// Whether the window in progress permits the enable.
function windowOpen() {
  return state.windowKey !== "" && state.windowLatched;
}

// The ladder. The clock is first because a Switch.Set overrides `follow` until the next input
// edge: reading it second would open an enable the user asked for the moment a window
// expired under it. It is also the rung that must work with the Cerbo down.
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

  // An initial value reported as a reading is an invented one.
  let lockPart = ", HP " + (!state.lockKnown
    ? "?"
    : (state.lockIsClosed ? "Enabled" : "Locked"));

  // A held value is shown as no reading, because that is what it is.
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

      // Usually the hardware: `follow` reasserts on a clock edge, opening a relay a window
      // may still want closed.
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

  try {
    // The lock. Its opening edge is also the entry window.
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

          // An edge only - .209 republishes its whole status on every reconnect. A restart
          // mid-shortage reads as one, costing at most an extra guarded hour.
          if (!state.lockIsClosed) {
            state.entryWindowUntil = Date.now() + config.window.entryWindowLength;
            console.log("Opening a DHW window for the next hour");
          }

          // The key only: the guard and the relay are the poll's business.
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

    // Read at the point of use, never acted on here: the bridge keeps publishing its held
    // values, so a controller that forgot them would take the next republish for a reading.
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

  // Where the wait for a reading fairly begins, on a reconnect as much as the first one.
  state.listeningSince = Date.now();

  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.topics) {
    let topic = topicPrefix + config.topics[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }

  MQTT.subscribe(config.heatPumpLock.statusTopic, processMqttMessage);
  logDebug("Subscribed to the heat pump lock: " + config.heatPumpLock.statusTopic);

  // Ask for a full republish, but from a later turn of the main loop than the subscriptions
  // above - see config.initialKeepaliveDelay.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
  });

  // The temperatures are self-announcing; the bridge state is not, and decides whether they
  // mean anything. The lock is Shelly status, asked for below.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.bufferTopReceived && state.boilerFlowReceived &&
                  state.bridgeConnectedReceived);
    requestFollowedStatus(false);
  });
}

// Shelly status is published on change and not retained, so a follower asks rather than
// waits - see README, Seeding State From Other Devices. Forced on connect, since the lock
// may have moved while the broker was away.
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

// The buffer readings go, since they may have changed unseen. The lock is kept: silence is
// not .209 saying the battery recovered.
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
    // .164 reads this device's input, so notifications off is a clock nobody hears. Tested
    // for false, not not-true: a firmware without the key must not reboot on every start.
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
function updateDeviceState() {
  let switchStatus = Shelly.getComponentStatus("switch:0");
  if (switchStatus && switchStatus.output !== undefined) {
    if (state.relayIsOn !== switchStatus.output) {
      state.relayIsOn = switchStatus.output;
      state.intendedRelayOn = switchStatus.output;
      logDebug("Relay state synced: " + state.relayIsOn);
    }
  }

  // The time clock, which `follow` already acts on: read here so the script does not undo it.
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

// Followed readings that have never arrived, each of which could justify a closed relay.
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
  updateWindow();
  updateWindowGuard();
  updateStatus("Monitoring");

  // Commanding this relay before the device is known would move someone else's contact.
  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  let reason = enableReason();

  // A relay already where it should be is not commanded: a Switch.Set would take `follow`
  // over until the next input edge for nothing.
  if (reason !== "") {
    if (!state.relayIsOn) {
      turnRelayOn(reason);
    }
    return;
  }

  if (!state.relayIsOn) {
    return;
  }

  // A restart finds the contact where the last run left it, so an incomplete picture waits
  // rather than shutting the zone valves on a live window. Past the grace, silence counts.
  let outstanding = outstandingReadings();

  if (outstanding !== "" && Date.now() - state.startedAt < config.startupGrace) {
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
