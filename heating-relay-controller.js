// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Heating Relay Controller for Shelly 1 Mini Gen3 - Boiler Release (192.168.1.164)
// Closes the Fröling's volt-free release contact when anything on the site wants wood
// burnt. Releasing is permission, never a command: the boiler holds its own 70 °C buffer
// target and decides for itself whether it fires.
//
// One ladder, first match wins:
//   1. H1            - the Grant's back-up heater request, on this relay's own input. The
//                      winter bivalent, and hardware `follow` answers it without this script
//   2. DHW demand    - the DHW time clock, on .123's input. A request for heat the system
//                      may not have, so the boiler answers it unconditionally
//   3. Power system  - VE.Bus not inverting for 30 minutes, or, while it is inverting, the
//                      heat pump lock open, which can then only be the battery
//   4. Exercise run  - fourteen days with no observed ignition, so that augers, grates and
//                      ignition get the opportunity to move
//
// Rung 3 reads VE.Bus itself and the lock second, in that order, because .209 opens the lock
// *because* VE.Bus left Inverting: while that is true the lock says nothing this controller
// cannot see for itself, and reading it first would release the boiler the moment a
// generator started. See CONTROLS.md and docs/adr/0001.

// ===== Configuration =====
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000 // ms to wait before reconnection attempt
  },

  // The one device this file belongs on, matched on the ID it reports at startup. .123 is
  // next door in the same cupboard and its relay looks identical, so a misdirected deploy
  // is a thing to survive rather than to guess at: an unrecognised device runs nothing.
  device: {
    id: "d885ac0818d0",
    name: "Boiler Release"
  },

  // The heat pump lock (.209). Closed means the heat pump is running, open means the system
  // is short. This controller follows it rather than deriving shortage from the power
  // system, which would cost four Victron subscriptions and a second copy of 30/90/500.
  heatPumpLock: {
    statusTopic: "shelly1minig3-d885ac0a3668/status/switch:0",
    commandTopic: "shelly1minig3-d885ac0a3668/command"
  },

  // The DHW time clock, which is the input of DHW Enable (.123). Its *input*, not its
  // relay: the relay also closes for a shortage DHW window, which exists because the heat
  // is already there. Releasing the boiler on one would be asking for heat on the grounds
  // of having some.
  dhwClock: {
    inputTopic: "shelly1minig3-48f6ee8e8780/status/input:0",
    commandTopic: "shelly1minig3-48f6ee8e8780/command"
  },

  // What waits, and for how long. Shedding electrical load is instant and reversible, so
  // shortage acts on it directly; lighting a boiler is neither.
  release: {
    // The only rung that waits. Everything else here is someone asking for heat, and this
    // one is the power system being in trouble - which it may not still be in a minute's
    // time. Thirty minutes clears the fortnightly generator test run - 20 minutes minimum
    // runtime - without knowing anything about generators at all.
    sustainedAfter: 30 * 60 * 1000,

    // A release this script granted is not withdrawn inside an hour, whatever changes
    // underneath it. By then the boiler may have begun an ignition cycle, which is the
    // expensive part and the part that wears, and roughly an hour is a burn: 1500 L from 40
    // to 70 degC.
    //
    // The third such rule in the repo and the only asymmetric one. `surplus` keeps a
    // symmetric minChangeTime per stage, so that its allocator has something that stands
    // still to budget against; `soc-relay` had a minimum on time and dropped it, because a
    // dump load's whole value is that shedding it is free. Here only one direction is
    // costly, so only one direction waits. It says nothing about a relay H1 is holding
    // closed - `follow` opens that on the H1 edge, and undoing the hardware is not what
    // this rule is for.
    minimumOnTime: 60 * 60 * 1000,

    // The Fröling needs to move periodically even when it is not needed for heat, and that
    // matters more now the heat pump carries the bulk of the load: a boiler that would once
    // have run all winter may sit idle in exactly the damp conditions that tar an auger.
    exerciseInterval: 14 * 24 * 60 * 60 * 1000,

    // Long enough for an ignition to have meant something, short enough not to be a
    // heating strategy. The boiler still self-gates on buffer temperature.
    exerciseHold: 60 * 60 * 1000
  },

  // Where the last observed ignition is written down. RAM would lose it on every reboot,
  // and a fourteen-day interval measured from a reboot is not an interval at all.
  kvs: {
    lastIgnition: "lastIgnition"
  },

  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    vebusState: "vebus/276/State",             // VE.Bus state - the power system rung, read
                                               // before the lock and never after it
    boilerOperating: "digitalinput/102/State"  // Boiler digital input (10=running, 11=stopped)
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
  inputIsActive: false,      // H1, the Grant's back-up heater request, on this relay's input

  // The heat pump lock, as published by .209. Kept across a broker drop: silence is not
  // .209 saying the battery recovered.
  lockIsClosed: false,       // Closed means the heat pump is running: no shortage
  lockKnown: false,          // Never having heard releases nothing, so an undeployed or
                             // unreachable .209 leaves H1 in hardware and nothing else

  // The DHW time clock, as published by .123. Cleared on a broker drop: a clock may have
  // moved while this controller was away, and .123 will not say so again until it next does
  dhwDemand: false,
  dhwDemandReceived: false,

  // Victron data
  vebusState: 0,             // VE.Bus state (0=Off, 9=Inverting, etc.)
  vebusReceived: false,      // Whether a state has ever arrived. Not cleared on a broker
                             // drop: a stale reading is trouble, an absent one is only a
                             // controller that has just started
  vebusStale: false,         // Set by a broker drop. The last reading is kept and shown as
                             // what it is, rather than zeroed into an invented "Off"
  vebusShortSince: 0,        // When the run of non-inverting readings began. Not cleared by
                             // a broker drop: the readings either side of a blip both say
                             // the inverter is off-grid abnormal
  boilerOperating: false,
  boilerReceived: false,     // Whether that was published rather than assumed

  // The exercise run
  lastIgnition: null,        // ms, from KVS. Null while unread, which makes the term inert
  ignitionReadPending: false,
  exerciseHoldUntil: 0,      // ms - while set, an exercise burn is under way

  releasedAt: 0,             // When this script last commanded the relay on, for the minimum
                             // on time. Zero for a relay it merely found closed

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

// A duration, for a log line and a status field. The largest unit that says something: an
// exercise clock is read in days and a generator run in minutes, and neither wants the
// other's precision - while "0m", for a run that has just started, says nothing at all.
function describeDuration(ms) {
  let seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return seconds + "s";
  }
  let minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes + "m";
  }
  let hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return hours + "h";
  }
  return Math.floor(hours / 24) + "d";
}

// Wall clock, in ms, or null where there is none to trust. The exercise run is the only
// term here that spans a reboot, so it is the only one that needs a clock the device did
// not invent: fourteen days is not an interval a script can time, and a timestamp written
// before NTP landed reads as decades once it arrives - which would light the boiler on the
// first poll after a redeploy. Every other term times an interval within one run, where
// Date.now() is right whether or not it agrees with the world.
function syncedNow() {
  let sys = Shelly.getComponentStatus("sys");

  if (!sys || !sys.unixtime || !sys.last_sync_ts) {
    return null;
  }

  return sys.unixtime * 1000;
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

// Resolve whether this is the device the file is written for. Everything it commands is one
// relay, so guessing is not an option a misdirected deploy recovers from: an unrecognised
// device runs nothing at all and leaves the relay in the unscripted behaviour its
// configuration gives, which for .164 is H1 released in hardware.
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

// ===== The terms that release the boiler =====

// The power system's rung, as the reason it releases the boiler for, or "" for none.
//
// VE.Bus and the heat pump lock are two readings of one condition rather than two rungs:
// .209 opens the lock *because* VE.Bus left Inverting, so while that is true the lock is the
// same fact arriving a second time, and reading it first would release the boiler the
// instant a generator started. Reading VE.Bus first leaves the lock exactly one thing left
// to mean.
function shortageRelease() {
  // The Fröling's augers, fan and pump all run off the house supply, so releasing the boiler
  // because the power system cannot be read risks lighting a fire and then losing
  // circulation. An unreadable power system asks for nothing and waits for an operator.
  if (!state.vebusReceived || state.vebusStale) {
    return "";
  }

  if (state.vebusState !== 9) {
    // Already burning: the thirty minutes was waited out by whatever released it, and a
    // script that has just restarted cannot measure what it did not watch. A relay H1 alone
    // is holding closed drops out of this by itself - `follow` opens it on the H1 edge, so
    // by the next check there is no release here to continue.
    if (state.relayIsOn) {
      return "shortage: VE.Bus " + getVebusStateString(state.vebusState);
    }

    if (!state.vebusShortSince ||
        Date.now() - state.vebusShortSince < config.release.sustainedAfter) {
      return "";
    }

    return "shortage: VE.Bus " + getVebusStateString(state.vebusState) + " for " +
           describeDuration(Date.now() - state.vebusShortSince);
  }

  // Inverting off-grid with the lock open leaves one cause: the battery. Nothing else opens
  // it without taking VE.Bus out of Inverting, and a battery at 30% is released by reaching
  // 90% rather than by the minute passing, so there is nothing here to wait for.
  if (state.lockKnown && !state.lockIsClosed) {
    return "shortage: battery";
  }

  return "";
}

// Drop the hold once the hour is up, which returns the term to the fourteen-day comparison
// - by then false, because the ignition that started the burn was written down.
function updateExerciseRun() {
  if (!state.exerciseHoldUntil) {
    return;
  }

  let now = syncedNow();

  if (now === null || now < state.exerciseHoldUntil) {
    return;
  }

  state.exerciseHoldUntil = 0;
  console.log("Exercise run complete - dropping the release");
}

// Fourteen days with no observed ignition, held for one hour once it lights.
//
// The boiler input is what completes an exercise run - it is how this controller learns the
// boiler lit, and so when to stop asking - and it arrives from the Cerbo like everything
// else. With it unavailable there is no exercise run to start or to finish, which is the
// same answer the power system's rung gives for the same reason, arrived at from the other
// end. A run interrupted that way is covered by the minimum on time, and resumes.
function exerciseDue() {
  let now = syncedNow();

  if (now === null || !state.boilerReceived) {
    return false;
  }

  if (state.exerciseHoldUntil) {
    return true;
  }

  if (state.lastIgnition === null) {
    return false;
  }

  return now - state.lastIgnition >= config.release.exerciseInterval;
}

// The ladder. The first rung that matches releases the boiler and the rest are moot, since
// the relay has only one position to be in - so the order is what each rung is worth as an
// explanation, not what it is worth as a reason. H1 first because the hardware has already
// acted on it; the exercise run last because it is the weakest, satisfied by an ignition
// from any cause at any time, and in no hurry.
function releaseReason() {
  if (state.inputIsActive) {
    return "H1";
  }

  if (state.dhwDemand) {
    return "DHW demand";
  }

  let shortage = shortageRelease();
  if (shortage !== "") {
    return shortage;
  }

  if (exerciseDue()) {
    return "exercise run";
  }

  return "";
}

// ===== The exercise clock, which has to survive a reboot =====

function writeLastIgnition(at) {
  state.lastIgnition = at;

  Shelly.call("KVS.Set", { key: config.kvs.lastIgnition, value: at },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error recording the ignition: " + error_message);
      }
    });
}

// Read the record back, and seed it on a device that has none.
//
// Seeding with the current time is what stops a redeploy lighting the boiler: the record is
// of *observed* ignitions, and a script that has just started has observed none. An
// unreadable record is treated the same way, because the two failures are not symmetrical -
// seeding delays an exercise by fourteen days, while reading a missing key as "no ignition
// ever" lights the boiler on the next poll.
function readLastIgnition() {
  if (state.ignitionReadPending || state.lastIgnition !== null) {
    return;
  }

  // Nothing to compare against, and nothing worth writing down: a timestamp taken now would
  // mean something else after the next NTP reply. The poll asks again.
  if (syncedNow() === null) {
    logDebug("No synchronised clock - the exercise run is inert for now");
    return;
  }

  state.ignitionReadPending = true;

  Shelly.call("KVS.Get", { key: config.kvs.lastIgnition },
    function(result, error_code, error_message) {
      state.ignitionReadPending = false;

      let now = syncedNow();

      if (error_code === 0 && result && result.value > 0) {
        state.lastIgnition = result.value;
        if (now !== null) {
          console.log("Last observed ignition: " +
                     describeDuration(now - state.lastIgnition) + " ago");
        }
        return;
      }

      if (now === null) {
        return;
      }

      console.log("No ignition on record (" + error_message +
                 ") - seeding the exercise clock with the current time");
      writeLastIgnition(now);
    });
}

// An ignition, wherever it came from. Every one of them exercises the same augers, so every
// one of them resets the fourteen days - but only one this controller asked for holds the
// release, since an ignition the heating side wanted needs no permission from here.
function recordIgnition() {
  let now = syncedNow();

  if (now === null) {
    logDebug("Ignition observed with no clock to record it against");
    return;
  }

  if (!state.exerciseHoldUntil && exerciseDue()) {
    state.exerciseHoldUntil = now + config.release.exerciseHold;
    console.log("Exercise run alight - holding the release for " +
               describeDuration(config.release.exerciseHold));
  }

  // The value is only ever read against fourteen days, and a lit boiler cycles several
  // times a day, so a re-ignition inside the hold is not worth a flash write.
  if (state.lastIgnition !== null &&
      now - state.lastIgnition <= config.release.exerciseHold) {
    logDebug("Ignition inside the hold - the record already says today");
    return;
  }

  writeLastIgnition(now);
}

// ===== Status =====
function updateStatus(event) {
  let relayPart = state.deviceName + (state.relayIsOn ? " ON" : " OFF");

  // Every one of these signals is silent between transitions, so a fresh start has none of
  // them - and reporting an initial value as a reading is an invented one, not a quiet one.
  let lockPart = ", HP " + (!state.lockKnown
    ? "?"
    : (state.lockIsClosed ? "Enabled" : "Locked"));

  // The one duration that decides anything now, so the one worth showing.
  let vebusShortPart = state.vebusShortSince
    ? " " + describeDuration(Date.now() - state.vebusShortSince)
    : "";
  let vebusPart = ", VE " + (!state.vebusReceived
    ? "?"
    : getVebusStateString(state.vebusState) + vebusShortPart +
      (state.vebusStale ? " (stale)" : ""));
  let boilerPart = ", Boiler " + (!state.boilerReceived
    ? "?"
    : (state.boilerOperating ? "ON" : "OFF"));
  let dhwPart = ", DHW " + (!state.dhwDemandReceived
    ? "?"
    : (state.dhwDemand ? "ON" : "OFF"));
  let h1Part = ", H1 " + (state.inputIsActive ? "ON" : "OFF");

  // The burn clock is the one value here written down against wall clock rather than timed
  // within this run, so it is read back against the same clock or not at all.
  let clock = syncedNow();
  let burnPart = (state.lastIgnition === null || clock === null)
    ? ""
    : ", burn " + describeDuration(clock - state.lastIgnition) + " ago";

  let reason = releaseReason();
  let releasePart = reason !== "" ? ", Released: " + reason : "";

  let eventPart = event ? ": " + event : "";

  let statusMessage = relayPart + lockPart + vebusPart + boilerPart + dhwPart + h1Part +
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

  // The exercise clock, before the first poll wants it. It needs a synchronised clock, so
  // the poll asks again for as long as there is none.
  readLastIgnition();

  startMonitoring();

  console.log("=== Heating Relay Controller Configuration ===");
  console.log("Device: " + state.deviceName);
  console.log("Releases the boiler on: H1, DHW demand, power system, exercise run");
  console.log("VE.Bus not inverting: released after " +
             (config.release.sustainedAfter / 60000) + " minutes");
  console.log("VE.Bus inverting with the heat pump locked: released at once (the battery)");
  console.log("Minimum on time: " +
             (config.release.minimumOnTime / 60000) + " minutes");
  console.log("Exercise run: " +
             (config.release.exerciseInterval / (24 * 60 * 60 * 1000)) +
             " days with no observed ignition, held " +
             (config.release.exerciseHold / 60000) + " minutes");
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

      // Something else moved the contact, and on this relay that something is usually the
      // hardware: `follow` reasserts itself on an H1 edge, so an H1 request ending opens a
      // relay this controller may still want closed for a shortage or an exercise run.
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

  try {
    // The heat pump lock, which is the whole of what this controller knows about the power
    // system apart from the VE.Bus state it uses to tell the two shortage terms apart.
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
          updateStatus("Heat pump lock changed");
        }
      }
      return;
    }

    // The DHW time clock, on .123's input.
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

    if (relativeTopic === config.topics.vebusState) {
      let prevState = state.vebusState;
      state.vebusState = parseInt(payload.value);
      state.vebusReceived = true;
      state.vebusStale = false;

      // When this run of non-inverting readings began, which is the only thing here that
      // waits. A broker drop does not disturb it: the readings either side of a blip both
      // say the inverter is off-grid abnormal, and the relay carries the answer meanwhile.
      if (state.vebusState !== 9) {
        if (!state.vebusShortSince) {
          state.vebusShortSince = Date.now();
        }
      } else {
        state.vebusShortSince = 0;
      }

      if (prevState !== state.vebusState) {
        console.log("VE.Bus state: " + state.vebusState +
                   " (" + getVebusStateString(state.vebusState) + ")");
      }
    }

    // The boiler input (10=running, 11=stopped). Its rising edge is the only observation of
    // an ignition this controller ever gets, and the exercise clock is made of them.
    if (relativeTopic === config.topics.boilerOperating) {
      let wasOperating = state.boilerOperating;
      let wasKnown = state.boilerReceived;
      state.boilerOperating = (payload.value === 10);
      state.boilerReceived = true;

      if (!wasKnown || wasOperating !== state.boilerOperating) {
        console.log("Boiler " + (state.boilerOperating ? "operating" : "stopped"));
      }

      if (state.boilerOperating && wasKnown && !wasOperating) {
        recordIgnition();
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

  // Ask for a full republish, but from a later turn of the main loop than the subscriptions
  // above - see config.initialKeepaliveDelay.
  Timer.set(config.initialKeepaliveDelay, false, function() {
    sendKeepalive(false);
    requestFollowedStatus(true);
  });

  // Keep asking for a republish until both silent readings have arrived. Neither
  // vebus/276/State nor the boiler input has anything to publish between transitions - one
  // changes when a generator runs, months apart, the other when the boiler starts or stops
  // firing - so both are only ever seen in a burst, and both are terms here.
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(state.vebusReceived && state.boilerReceived);
    requestFollowedStatus(false);
  });
}

// Shelly publishes status on change and does not retain it, so a follower that has just
// started believes the heat pump is running and the time clock off until each device next
// moves - which for a relay's input, with no telemetry to drift, can be hours.
// `status_update` on a device's command topic makes it republish every component on the
// topics this controller already subscribes to, so asking costs no extra subscription and
// no HTTP.
//
// Asked on connect, and again on every keepalive until the answer arrives, since the
// request is as losable as the answer. Forced on connect, because a value already held may
// have changed while the broker was away and neither device will repeat it.
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

// What a drop does to a flag differs by what the value is for. The time clock may have
// moved while the broker was away, so forgetting it is right: it will be asked again on
// reconnect. The lock is kept, because silence is not .209 saying the battery recovered, and
// so is the run of non-inverting readings: the readings either side of a blip both say the
// inverter is off-grid abnormal, and a thirty minutes restarted on every blip never elapses.
// The boiler state is forgotten, which suspends the exercise run until the Cerbo is back.
//
// The VE.Bus state is marked stale rather than zeroed. A stale reading asks for nothing
// either way, so zeroing it bought nothing and cost a status line that read "VE Off" - a
// reading nobody sent.
function resetMqttData() {
  state.vebusStale = true;
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
    // This relay's own position is what a person reads in VRM to see why the boiler is
    // burning. Tested for false, not for not-true: a firmware without the key must not
    // reboot on every start.
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

  // H1, the Grant's back-up heater request. Wired to this relay's input, which `follow`
  // already acts on: reading it here is how the script knows not to undo that.
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
  state.releasedAt = Date.now();

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

// Which followed readings have never arrived. Every one of them could justify a release,
// and each is silent between transitions, so a fresh start has none of them.
function outstandingReadings() {
  let missing = [];

  if (!state.lockKnown) {
    missing.push("the heat pump lock");
  }
  if (!state.dhwDemandReceived) {
    missing.push("the DHW time clock");
  }
  if (!state.boilerReceived) {
    missing.push("the boiler state");
  }
  if (!state.vebusReceived) {
    missing.push("the inverter state");
  }

  return missing.join(", ");
}

function checkSystemState() {
  updateStatus("Monitoring");

  // Commanding this relay before the device is known would burn someone else's wood.
  if (!state.identityKnown) {
    logDebug("Identity not yet known - no action");
    return;
  }

  updateExerciseRun();

  let reason = releaseReason();

  // A relay already where it should be is not commanded. That matters most for H1, which
  // hardware `follow` has already answered: a Switch.Set overrides follow until the next
  // input edge, and there is nothing to gain by taking that over.
  if (reason !== "") {
    if (!state.relayIsOn) {
      turnRelayOn(reason);
    }
    return;
  }

  if (!state.relayIsOn) {
    return;
  }

  // A release this script granted stands for an hour whatever changes underneath it. Not a
  // relay it merely found closed: that one belongs to whatever closed it.
  if (state.releasedAt &&
      Date.now() - state.releasedAt < config.release.minimumOnTime) {
    logDebug("Nothing is asking for the boiler, but it was released " +
            describeDuration(Date.now() - state.releasedAt) + " ago - leaving it alone");
    return;
  }

  // Nothing asking is not the same as nothing having answered. A restart finds the contact
  // wherever the last run left it, and every reading that could justify it arrives over
  // MQTT some time later, so an incomplete picture waits rather than dropping a burn on
  // every redeploy. Past the grace, silence is taken at face value.
  let outstanding = outstandingReadings();

  if (outstanding !== "" && Date.now() - state.startedAt < config.startupGrace) {
    logDebug("Released, and still waiting on " + outstanding + " - leaving the relay alone");
    return;
  }

  turnRelayOff("Nothing is asking for the boiler");
}

function checkStatus() {
  updateDeviceState();

  // Until the record has been read there is no exercise term at all, so keep asking. It
  // needs a synchronised clock, and a device that has just booted may not have one yet.
  readLastIgnition();

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
