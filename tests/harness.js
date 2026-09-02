// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Loads a Shelly controller script under stubbed device globals so its decision
// functions can be exercised from Node. The scripts are flat mJS — top-level
// functions over module-level `config` and `state` — so appending an exports line
// is enough to reach them; nothing in the controllers is modified for testing.
//
// Shelly.call never invokes its callback, so the script's own init() stalls
// harmlessly after the first RPC and never starts timers or MQTT. It gets as far
// as resolving its identity, which is synchronous, so a load() given a device ID
// starts where a real deployment on that device would.

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");

// Names exported from a loaded script, across all of them. Each is guarded, so a
// script that does not define one simply exports undefined for it rather than
// failing to load. Anything not listed here is unreachable from a test, so add to
// this list rather than reaching into internals.
const EXPORTED = [
  "config",
  "state",
  // surplus-dump-controller
  "calculateDesiredState",
  "suppressAllLoads",
  "applyDesiredState",
  "sendRemoteSwitchCommand",
  "getDumpLoadPower",
  // thermal-dump-controller
  "isLoadStalled",
  "isDumpLoadStalled",
  "getDumpLoadState",
  // soc-relay-controller
  "applySettingsForDevice",
  "inShortage",
  "updateShortageLatch",
  "shortageReason",
  "setupVirtualComponents",
  "handleMqttConnected",
  "connectMqtt",
  "recordSwitchTime",
  "assignFollowedTopics",
  "requestFollowedStatus",
  "seedLatchFromRelay",
  "determineDeviceIdentity",
  "finishSetup",
  // heating-relay-controller
  "syncedNow",
  "releaseReason",
  "shortageRelease",
  "exerciseDue",
  "updateExerciseRun",
  "recordIgnition",
  "readLastIgnition",
  "outstandingReadings",
  // common
  "setupMqttSubscriptionsAndKeepalive",
  "processMqttMessage",
  "updateStatus",
  "checkSystemState",
  "resetMqttData",
];

function exportsLine() {
  const entries = EXPORTED.map(
    (name) => name + ": typeof " + name + " !== \"undefined\" ? " + name + " : undefined"
  );
  return "\nmodule.exports = { " + entries.join(", ") + " };\n";
}

let loadCounter = 0;

// Load `scriptName` from the repo root, as if deployed on `deviceId`. Returns the
// script's internals plus the MQTT traffic, the RPC calls, the timers it set and the
// MQTT handlers it installed, so tests can assert on what it published, subscribed
// to, commanded and scheduled. Each call is a fresh copy with fresh state. The
// default ID is in no controller's relay table, so a load that does not name a
// device resolves no role.
function load(scriptName, deviceId) {
  const published = [];
  const subscribed = [];
  const calls = [];
  const timers = [];
  const handlers = {};

  const source =
    fs.readFileSync(path.join(REPO_ROOT, scriptName), "utf8") + exportsLine();

  const stubs = {
    Shelly: {
      // Never calls back, so a script's own init() stalls here rather than
      // starting timers. The record is what a test asserts a controller did. The
      // callback is kept rather than dropped, so a test that needs an answer -
      // a KVS read, where "no such key" is itself the interesting case - can
      // invoke it as the device would.
      call: function (method, params, cb) { calls.push({ method, params, cb }); },
      addStatusHandler: function () {},
      addEventHandler: function () {},
      getComponentStatus: function () { return null; },
      getComponentConfig: function () { return null; },
      getDeviceInfo: function () {
        return { id: deviceId || "shelly1pmg3-000000000000" };
      },
    },
    MQTT: {
      subscribe: function (topic) { subscribed.push(topic); },
      publish: function (topic, payload) { published.push({ topic, payload }); },
      setConnectHandler: function (fn) { handlers.connect = fn; },
      setDisconnectHandler: function (fn) { handlers.disconnect = fn; },
    },
    Timer: {
      // Recorded rather than run: a test decides whether a scheduled callback fires.
      set: function (ms, repeat, fn) {
        timers.push({ ms: ms, repeat: repeat, fn: fn });
        return timers.length;
      },
      clear: function () {},
    },
    Virtual: {
      getHandle: function () { return null; },
    },
  };

  // A distinct filename per load defeats the require cache, so each test gets
  // its own module-level state rather than inheriting the previous test's.
  const tmp = path.join(
    os.tmpdir(),
    "shelly-under-test-" + process.pid + "-" + loadCounter++ + ".js"
  );
  fs.writeFileSync(tmp, source);

  // Leave the stubs installed: the loaded script reaches for these globals on
  // every later call too, not just at load time. Test bodies are synchronous, so
  // each load() owning the globals for its own duration is safe.
  Object.assign(global, stubs);

  let mod;
  try {
    mod = require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }

  return { mod, published, subscribed, calls, timers, handlers };
}

// Everything a call printed. A controller logs its status line as well as setting it, and
// under the harness the virtual component handle is null, so the log is the observable.
function captureLog(fn) {
  const lines = [];
  const realLog = console.log;
  console.log = function (line) { lines.push(line); };
  try {
    fn();
  } finally {
    console.log = realLog;
  }
  return lines.join("\n");
}

module.exports = { load, captureLog };
