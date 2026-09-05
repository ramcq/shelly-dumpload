// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// DHW Controller for Shelly 1 Mini Gen3 - DHW Enable (192.168.1.123)
// Closes the DHW enable, which is permission for heat to move from the buffer into the
// cylinders. Permission, not a command: the three cylinder thermostats decide whether
// anything actually moves, which is why nothing here senses cylinder temperature. Close the
// enable and a cool cylinder loads itself; a hot one does nothing.
//
// One ladder, first match wins:
//   1. The time clock  - this relay's own input, unconditionally. No reference to buffer
//                        temperature, the heat pump, or anything arriving over MQTT: the
//                        switch says heat, so heat. Hardware `follow` answers it without
//                        this script, and this rung is what stops the script undoing it
//   2. A shortage DHW  - in shortage the heat pump is locked and the immersion time switch
//      window            is blocked, so the buffer is the only route to hot water. The
//                        controller runs the time clock the user would otherwise turn on by
//                        hand: one hour in six, guarded by buffer temperature
//
// Nothing takes DHW from the buffer outside shortage. The immersions make the same water
// from the same surplus more directly, and an enable that moves no energy still runs the
// heat loop pump and mixes a buffer `thermal-dump-controller.js` needs stratified.
//
// A window permits heat that is already there and asks for none, so it is not DHW demand
// and releases no boiler. .164 reads this device's *input* for that, never its relay.
// See CONTROLS.md.

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000 // ms to wait before reconnection attempt
  },

  // The one device this file belongs on, matched on the ID it reports at startup. .164 is
  // next door in the same cupboard and its relay looks identical, so a misdirected deploy
  // is a thing to survive rather than to guess at: an unrecognised device runs nothing, and
  // a guess here would burn wood.
  device: {
    id: "48f6ee8e8780",
    name: "DHW Enable"
  },

  // The heat pump lock (.209). Closed means the heat pump is running, open means the system
  // is short. This controller follows it rather than deriving shortage from the power
  // system, which would cost SOC, both generation figures and the inverter output on top of
  // the inverter state - four subscriptions and a second copy of 30/90/500, for a script
  // whose job is moving heat between vessels.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // The shortage DHW window: when the controller may close the enable in place of the time
  // clock, and what has to be true of the buffer before it does.
  window: {
    // One hour in six, local time, as the device reports the hour: two characters, leading
    // zero and all. Fixed times need no anchor to persist and so survive a reboot with
    // nothing written down. One in six rather than the two in twelve the physical clock
    // would use, because a window need not finish a charge: a partial one resumes six hours
    // later, and the annex cylinder is small enough that one shower empties it.
    slotHours: ["05", "11", "17", "23"],

    // A shortage beginning at 07:30 should not wait until noon for its first hot water, so
    // entering shortage is a window of its own. An interval rather than a time, which is
    // why it needs no synchronised clock.
    entryWindowLength: 60 * 60 * 1000,

    // The cylinder stats know nothing about the primary side, so a window on a cold buffer
    // circulates through the coils and strips heat back *out* of the cylinders. Buffer top
    // or boiler flow, whichever is higher: top measures the energy actually stored but lags
    // ignition by 10-15 minutes, while flow is the earliest honest signal and matches the
    // hydraulics but cools when the boiler stops even with 1500 litres of heat behind it.
    minBufferTemp: 60
  },

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    bufferTop: "temperature/100/Temperature",  // Buffer top, from dbus-froeling
    boilerFlow: "temperature/103/Temperature"  // Fröling register 30001, Kesseltemperatur
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
  identityKnown: false,      // Whether this is the device the file is written for
  deviceName: "",

  // Relay control state
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // Intended relay state (prevents re-entrancy)
  inputIsActive: false,      // The DHW time clock, on this relay's own input

  // The heat pump lock, as published by .209. Kept across a broker drop: silence is not
  // .209 saying the battery recovered.
  lockIsClosed: false,       // Closed means the heat pump is running: no shortage
  lockKnown: false,          // Never having heard opens no window, so an undeployed or
                             // unreachable .209 leaves the time clock in hardware and
                             // nothing else

  // The buffer, from the Fröling by way of dbus-froeling. Both are self-announcing - they
  // arrive every few seconds whether or not they have moved - so a drop clears them: the
  // silence means this controller cannot see the buffer, not that the buffer stopped.
  bufferTop: 0,
  bufferTopReceived: false,
  boilerFlow: 0,
  boilerFlowReceived: false,

  // The window in progress. A key rather than a deadline, because a slot is a slot: the
  // scheduled ones are identified by the hour they start, the entry one by being the entry
  // one, and the latch belongs to whichever is open.
  windowKey: "",
  windowLatched: false,      // Whether the enable has closed within this window. Once it
                             // has it stays closed until the window ends, or a burn
                             // finishing mid-window shuts the zone valves and a buffer
                             // hovering at 60 degC cycles three actuators
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

// The local wall-clock hour as the device writes it - "05", "17" - or "" where there is
// none to trust. The scheduled slots are times of day rather than intervals, so they are the
// one thing here that needs a clock the device did not invent: `sys.time` is null until the
// device has actually reached an NTP server, and a device that has never synchronised still
// reports a plausible-looking date, which is the dangerous shape of wrong. Without one there
// are no scheduled slots at all; the entry window is an interval and works regardless.
//
// Compared as text rather than parsed to a number, because the slots are known strings and
// `sys.time` is documented to carry the leading zero: nothing here has to decide what "08"
// is worth.
function localHourText() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || !sys.time || !sys.last_sync_ts) {
    return "";
  }

  return sys.time.substring(0, 2);
}

// Resolve whether this is the device the file is written for. Everything it commands is one
// relay, so guessing is not an option a misdirected deploy recovers from: an unrecognised
// device runs nothing at all and leaves the relay in the unscripted behaviour its
// configuration gives, which for .123 is the time clock passing straight through.
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

// The hotter of the two buffer readings, or null where neither has arrived. Zero is a
// reading nobody sent, and reading it as a cold buffer would be the same mistake in the
// safe direction rather than an honest answer.
function guardTemperature() {
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

// Which window this moment falls in, or "" for none. Shortage first, because that is what a
// window is *for*: outside it the immersions make the same water from the same surplus more
// directly. A scheduled slot outranks the entry window, so the two overlapping report one
// key rather than alternating.
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

// Move the latch to the window this moment is in. Called before the ladder is read, so that
// what the ladder and the status line see is the same window.
function updateWindow() {
  let key = currentWindowKey();

  if (key === state.windowKey) {
    return;
  }

  if (key === "") {
    console.log("Shortage DHW window " + state.windowKey + " ended");
    state.windowKey = "";
    state.windowLatched = false;
    return;
  }

  // The latch survives a change of key, and only because it is cleared the moment there is
  // no window at all: still set here means the previous check was inside one, so the two
  // touch and are one continuous window. An entry window running into 05:00 is the case,
  // and shutting the valves at the top of an hour it was already open through would be the
  // very cycling the latch exists to prevent.
  console.log("Shortage DHW window " + key + " open" +
             (state.windowLatched ? " (continuing)" : ""));
  state.windowKey = key;
}

// The guard, checked throughout the hour rather than at the top of it - a boiler that lifts
// the buffer past 60 degC at 05:20 still gets a window, and a late guard gets a short run,
// which is accepted. Once it has passed the answer latches for the rest of the window: one
// flag in RAM, cleared with the window, with no timer, no re-arm threshold and no
// hysteresis.
//
// Runs after updateWindow(), and only from the poll, which is what makes the latch mean what
// it says: the check that sets it is the check that closes the enable. Latching anywhere
// else - on the lock's own edge, say - would record a guard that had passed up to a poll
// before the relay moved, and a buffer can fall through 60 degC in between.
function updateWindowGuard() {
  if (state.windowKey === "" || state.windowLatched) {
    return;
  }

  if (!guardSatisfied()) {
    return;
  }

  state.windowLatched = true;
  console.log("Shortage DHW window " + state.windowKey + " guarded at " +
             guardTemperature().toFixed(1) + " degC - the buffer has something to give");
}

// Whether the window in progress permits the enable.
function windowOpen() {
  return state.windowKey !== "" && state.windowLatched;
}

// The ladder. The first rung that matches closes the enable and the rest are moot, since the
// relay has only one position to be in.
//
// The time clock is first because it takes authority: a Switch.Set overrides `follow` until
// the next input edge, so a controller that read its own input second would open an enable
// the user asked for at 05:30 the moment its window expired at 06:00. It is also the rung
// that must keep working with the Cerbo down, the Fröling stale or the network broken, so
// nothing above it may depend on any of them.
function enableReason() {
  if (state.inputIsActive) {
    return "time clock";
  }

  if (windowOpen()) {
    return "shortage DHW window (" + state.windowKey + ")";
  }

  return "";
}

// ===== Status =====
function updateStatus(event) {
  let relayPart = state.deviceName + (state.relayIsOn ? " ON" : " OFF");

  // None of the lock or the two temperatures has a value until it arrives, and an initial
  // value reported as a reading is an invented one. The lock is the silent one of the three
  // and may be months away; the temperatures are only seconds off.
  let lockPart = ", HP " + (!state.lockKnown
    ? "?"
    : (state.lockIsClosed ? "Enabled" : "Locked"));

  let bufferPart = ", Buffer " + (!state.bufferTopReceived
    ? "?"
    : state.bufferTop.toFixed(1) + "C");
  let flowPart = ", Flow " + (!state.boilerFlowReceived
    ? "?"
    : state.boilerFlow.toFixed(1) + "C");

  let clockPart = ", Clock " + (state.inputIsActive ? "ON" : "OFF");

  let windowPart = ", Window " + (state.windowKey === ""
    ? "-"
    : state.windowKey + (state.windowLatched ? " held" : " waiting"));

  let reason = enableReason();
  let enabledPart = reason !== "" ? ", Enabled: " + reason : "";

  let eventPart = event ? ": " + event : "";

  let statusMessage = relayPart + lockPart + bufferPart + flowPart + clockPart +
                      windowPart + enabledPart + eventPart;

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

      // Something else moved the contact, and on this relay that something is usually the
      // hardware: `follow` reasserts itself on a time clock edge, so a clock going off opens
      // a relay a window may still want closed.
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
    // The heat pump lock, which is the whole of what this controller knows about the power
    // system. Its opening edge is also the entry window: a shortage beginning at 07:30
    // should not wait until noon for its first hot water.
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

          // Only an edge, never a republish of what was already held: .209 republishes its
          // whole status on every reconnect, and this window is for a shortage that has
          // just begun. A restart mid-shortage is an edge as far as this controller can
          // tell, which costs at most one extra guarded hour.
          if (!state.lockIsClosed) {
            state.entryWindowUntil = Date.now() + config.window.entryWindowLength;
            console.log("Opening a DHW window for the next hour");
          }

          // Before the status line rather than after it: shortage is what a window is made
          // of, so a lock that has just moved leaves the previous window's key describing a
          // window that no longer exists. The key only - the guard and the relay are both
          // the poll's business, and in that order.
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
  } catch (e) {
    console.log("Error processing MQTT message: " + e.message);
  }
}

function handleMqttConnected() {
  console.log("Connected to MQTT broker");
  state.mqttConnected = true;

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

  // Both buffer readings are self-announcing, so the full republish is only needed until
  // they have first arrived. The lock is not, and is asked for separately below.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.bufferTopReceived && state.boilerFlowReceived);
    requestFollowedStatus(false);
  });
}

// Shelly publishes status on change and does not retain it, so a follower that has just
// started believes nothing at all until the lock next moves - which, for a relay that
// changes a handful of times a year, may be months. `status_update` on .209's command topic
// makes it republish every component on the topic this controller already subscribes to, so
// asking costs no extra subscription and no HTTP.
//
// Asked on connect, and again on every keepalive until the answer arrives, since the request
// is as losable as the answer. Forced on connect, because the lock may have moved while the
// broker was away and .209 will not repeat it.
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

// What a drop does to a flag differs by what the value is for. The buffer readings are
// self-announcing - they arrive every few seconds whether or not they have moved - so
// silence means this controller cannot see the buffer, and a guard is not passed on a
// reading it no longer has. The lock is kept, because silence is not .209 saying the battery
// recovered, and forgetting it would end a window on a broker blip.
function resetMqttData() {
  state.bufferTop = 0;
  state.bufferTopReceived = false;
  state.boilerFlow = 0;
  state.boilerFlowReceived = false;

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
    // .164 reads this device's input for its DHW demand rung, so notifications off is a
    // time clock whose call never leaves the cupboard. Tested for false, not for not-true:
    // a firmware without the key must not reboot on every start.
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

  // The DHW time clock, wired to this relay's input, which `follow` already acts on:
  // reading it here is how the script knows not to undo that.
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

// Which followed readings have never arrived. Every one of them is a term of the window, and
// the lock is silent between transitions while the temperatures are only seconds away, so a
// fresh start has none of them.
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

  // A relay already where it should be is not commanded. That matters most for the time
  // clock, which hardware `follow` has already answered: a Switch.Set overrides follow until
  // the next input edge, and there is nothing to gain by taking that over.
  if (reason !== "") {
    if (!state.relayIsOn) {
      turnRelayOn(reason);
    }
    return;
  }

  if (!state.relayIsOn) {
    return;
  }

  // Nothing asking is not the same as nothing having answered. A restart finds the contact
  // wherever the last run left it, and every reading that could justify it arrives over MQTT
  // some time later, so an incomplete picture waits rather than shutting the zone valves on
  // a live window at every redeploy. Past the grace, silence is taken at face value.
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
