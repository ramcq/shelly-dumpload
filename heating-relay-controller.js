// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Heating Relay Controller for Shelly 1 Mini Gen3 - Boiler Release (192.168.1.164)
// Closes the Fröling's release contact. Releasing is permission: the boiler keeps its own
// 70 °C buffer target and decides whether to fire.
//
// Ladder, first match wins:
//   1. H1           - the Grant's back-up heater request, on this relay's input (hardware
//                     `follow` acts on it without the script)
//   2. DHW demand   - the DHW time clock, on .123's input
//   3. Shortage     - the heat pump lock (.209) open for 30 minutes
//   4. Exercise run - every other Sunday at 11:00, unless an ignition was seen in the last
//                     14 days
//
// Rules and reasoning in CONTROLS.md#shedding-is-not-the-same-as-making-heat.

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
    id: "d885ac0818d0",
    name: "Boiler Release"
  },

  // The heat pump lock (.209): closed means the heat pump runs, open means shortage.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // The DHW time clock, on .123's input. Not its relay, which also closes for a shortage DHW
  // window, and a window asks for no heat.
  dhwClock: {
    inputTopic: "shelly1minig3-48f6ee8e8780/status/input:0",
    commandTopic: "shelly1minig3-48f6ee8e8780/command"
  },

  release: {
    sustainedAfter: 30 * 60 * 1000,    // How long the lock must be open before releasing
    minimumOnTime: 60 * 60 * 1000,     // A release this script makes is not dropped sooner

    // Exercise slot: UTC days since the epoch modulo 14 (3 is a Sunday), and the local hour.
    exerciseCycleDays: 14,
    exerciseDay: 3,
    exerciseHour: "11",
    exerciseInterval: 14 * 24 * 60 * 60 * 1000  // An ignition this recent skips the slot
  },

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    boilerOperating: "digitalinput/102/State" // Boiler digital input (10=running, 11=stopped)
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

  // Device identity
  identityKnown: false,
  deviceName: "",

  // Relay control state
  relayIsOn: false,          // Current relay state (actual)
  intendedRelayOn: false,    // State last commanded
  inputIsActive: false,      // H1
  releasedAtUptime: null,    // When this script last released, for the minimum on time

  // The heat pump lock. Kept across a broker drop.
  lockIsClosed: false,
  lockKnown: false,
  lockOpenSinceUptime: null,

  // The DHW time clock. Cleared on a broker drop.
  dhwDemand: false,
  dhwDemandReceived: false,

  // The boiler input, for observing ignitions
  boilerOperating: false,
  boilerReceived: false,
  lastIgnitionUptime: null,

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

// True until the grace has run out, or while uptime has never been read.
function withinStartupGrace() {
  if (state.nowUptime === null || state.startedAtUptime === null) {
    return true;
  }

  return state.nowUptime - state.startedAtUptime < config.startupGrace;
}

// ===== Virtual component handles =====
let handles = {
  status: null
};

// ===== Helper functions =====
function logDebug(message) {
  if (config.debugMode) {
    console.log("[DEBUG-HEAT] " + message);
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

function describeDuration(ms) {
  let minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return minutes + "m";
  }
  let hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return hours + "h";
  }
  return Math.floor(hours / 24) + "d";
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

// ===== The rungs =====

function shortageDue() {
  return state.lockOpenSinceUptime !== null && state.nowUptime !== null &&
         state.nowUptime - state.lockOpenSinceUptime >= config.release.sustainedAfter;
}

// Inside the exercise slot, with a synchronised clock and no recent ignition.
function exerciseDue() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || !sys.unixtime || !sys.time || !sys.last_sync_ts) {
    return false;
  }

  let day = Math.floor(sys.unixtime / 86400);
  if (day % config.release.exerciseCycleDays !== config.release.exerciseDay ||
      sys.time.substring(0, 2) !== config.release.exerciseHour) {
    return false;
  }

  return state.lastIgnitionUptime === null ||
         state.nowUptime - state.lastIgnitionUptime >= config.release.exerciseInterval;
}

function releaseReason() {
  if (state.inputIsActive) {
    return "H1";
  }

  if (state.dhwDemand) {
    return "DHW demand";
  }

  if (shortageDue()) {
    return "shortage";
  }

  if (exerciseDue()) {
    return "exercise run";
  }

  return "";
}

// ===== Status =====
function updateStatus(event) {
  let relayPart = state.deviceName + (state.relayIsOn ? " ON" : " OFF");

  let lockPart = ", HP ";
  if (!state.lockKnown) {
    lockPart += "?";
  } else if (state.lockIsClosed) {
    lockPart += "Enabled";
  } else {
    lockPart += "Locked " + describeDuration(state.nowUptime - state.lockOpenSinceUptime);
  }

  let boilerPart = ", Boiler " + (!state.boilerReceived
    ? "?"
    : (state.boilerOperating ? "ON" : "OFF"));
  let dhwPart = ", DHW " + (!state.dhwDemandReceived
    ? "?"
    : (state.dhwDemand ? "ON" : "OFF"));
  let h1Part = ", H1 " + (state.inputIsActive ? "ON" : "OFF");

  let burnPart = state.lastIgnitionUptime === null
    ? ""
    : ", lit " + describeDuration(state.nowUptime - state.lastIgnitionUptime) + " ago";

  let reason = releaseReason();
  let releasePart = reason !== "" ? ", Released: " + reason : "";

  let eventPart = event ? ": " + event : "";

  let statusMessage = relayPart + lockPart + boilerPart + dhwPart + h1Part +
                      burnPart + releasePart + eventPart;

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

  console.log("=== Heating Relay Controller Configuration ===");
  console.log("Device: " + state.deviceName);
  console.log("Releases the boiler on: H1, DHW demand, shortage, exercise run");
  console.log("Shortage: heat pump lock open for " +
             (config.release.sustainedAfter / 60000) + " minutes");
  console.log("Minimum on time: " + (config.release.minimumOnTime / 60000) + " minutes");
  console.log("Exercise run: every " + config.release.exerciseCycleDays + " days at " +
             config.release.exerciseHour + ":00 unless the boiler has lit since");
  console.log("Heat Pump Lock Monitoring: " + config.heatPumpLock.statusTopic);
  console.log("DHW Time Clock Monitoring: " + config.dhwClock.inputTopic);
  console.log("Check Interval: " + (config.checkInterval / 1000) + " seconds");
  console.log("=============================================");

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

      // Usually `follow` opening the relay on an H1 edge; check whether anything else
      // still wants it closed.
      state.relayIsOn = newState;
      state.intendedRelayOn = newState;
      logDebug("Relay state changed externally to: " + newState);
      checkSystemState();
    }

    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      state.inputIsActive = event.info.state;
      console.log("H1 back-up heater request " +
                 (state.inputIsActive ? "active" : "released"));
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
    if (topic === config.heatPumpLock.statusTopic) {
      let payload = JSON.parse(message);
      if (payload.output !== undefined) {
        let wasClosed = state.lockIsClosed;
        let wasKnown = state.lockKnown;
        state.lockIsClosed = Boolean(payload.output);
        state.lockKnown = true;

        if (state.lockIsClosed) {
          state.lockOpenSinceUptime = null;
        } else if (state.lockOpenSinceUptime === null) {
          state.lockOpenSinceUptime = state.nowUptime;
        }

        if (!wasKnown || wasClosed !== state.lockIsClosed) {
          console.log("Heat pump lock " +
                     (state.lockIsClosed ? "closed - no shortage" : "open - SHORTAGE"));
          updateStatus("Heat pump lock changed");
        }
      }
      return;
    }

    if (topic === config.dhwClock.inputTopic) {
      let payload = JSON.parse(message);
      if (payload.state !== undefined) {
        let wasCalling = state.dhwDemand;
        let wasKnown = state.dhwDemandReceived;
        state.dhwDemand = Boolean(payload.state);
        state.dhwDemandReceived = true;

        if (!wasKnown || wasCalling !== state.dhwDemand) {
          console.log("DHW time clock " + (state.dhwDemand ? "calling" : "off"));
          updateStatus("DHW demand changed");
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

    // The boiler input. A stopped-to-running edge is an ignition; the first reading is not.
    if (relativeTopic === config.topics.boilerOperating) {
      let wasOperating = state.boilerOperating;
      let wasKnown = state.boilerReceived;
      state.boilerOperating = (payload.value === 10);
      state.boilerReceived = true;

      if (!wasKnown || wasOperating !== state.boilerOperating) {
        console.log("Boiler " + (state.boilerOperating ? "operating" : "stopped"));
      }

      if (state.boilerOperating && wasKnown && !wasOperating) {
        state.lastIgnitionUptime = state.nowUptime;
      }
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

  MQTT.subscribe(config.dhwClock.inputTopic, processMqttMessage);
  logDebug("Subscribed to the DHW time clock: " + config.dhwClock.inputTopic);

  // Ask for republishes once the subscriptions are live
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
  });

  // Keep asking until each silent reading has arrived
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.boilerReceived);
    requestFollowedStatus(false);
  });
}

// Ask the followed Shellys to republish their status; forced on connect.
function requestFollowedStatus(force) {
  if (force || !state.lockKnown) {
    askToRepublish(config.heatPumpLock.commandTopic, "the heat pump lock");
  }

  if (force || !state.dhwDemandReceived) {
    askToRepublish(config.dhwClock.commandTopic, "the DHW time clock");
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

// The lock and its timer are kept: silence is not .209 saying the battery recovered.
function resetMqttData() {
  state.dhwDemand = false;
  state.dhwDemandReceived = false;
  state.boilerOperating = false;
  state.boilerReceived = false;

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

// Returns true if a reconfigure (and so a reboot) is under way.
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
    // Tested for false so that firmware without the key is not rebooted on every start
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
      logDebug("H1 synced from local input: " + state.inputIsActive);
    }
  }
}

// ===== Relay control =====
function turnRelayOn(reason) {
  logDebug("Attempting to release the boiler: " + reason);

  state.intendedRelayOn = true;
  state.releasedAtUptime = state.nowUptime;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error releasing the boiler: " + error_message);
        state.intendedRelayOn = state.relayIsOn;
        return;
      }

      state.relayIsOn = true;
      console.log("Boiler released: " + reason);
      updateStatus(reason);
    }
  );
}

function turnRelayOff(reason) {
  logDebug("Attempting to drop the release: " + reason);

  state.intendedRelayOn = false;

  Shelly.call(
    "Switch.Set",
    { id: 0, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error dropping the release: " + error_message);
        state.intendedRelayOn = state.relayIsOn;
        return;
      }

      state.relayIsOn = false;
      console.log("Boiler release dropped: " + reason);
      updateStatus(reason);
    }
  );
}

function checkSystemState() {
  refreshUptime();

  updateStatus("Monitoring");

  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  let reason = releaseReason();

  // Not commanded if already on, so as not to override `follow` for H1
  if (reason !== "") {
    if (!state.relayIsOn) {
      turnRelayOn(reason);
    }
    return;
  }

  if (!state.relayIsOn) {
    return;
  }

  if (state.releasedAtUptime !== null &&
      state.nowUptime - state.releasedAtUptime < config.release.minimumOnTime) {
    logDebug("Within the minimum on time - leaving the release");
    return;
  }

  // A relay found closed at startup waits until the lock and the DHW clock have been heard.
  if ((!state.lockKnown || !state.dhwDemandReceived) && withinStartupGrace()) {
    logDebug("Released, and still waiting on the lock or the DHW clock");
    return;
  }

  turnRelayOff("Nothing is asking for the boiler");
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
  console.log("Heating Relay Controller starting");

  updateDeviceState();

  if (!determineDeviceIdentity()) {
    return;
  }

  initializeVirtualComponents();
}

// Run initialization
init();
