// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Loads a Shelly controller script under stubbed device globals so its decision
// functions can be exercised from Node. The scripts are flat mJS — top-level
// functions over module-level `config` and `state` — so appending an exports line
// is enough to reach them; nothing in the controllers is modified for testing.
//
// Shelly.call never invokes its callback, so the script's own init() stalls
// harmlessly after the first RPC and never starts timers or MQTT.

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
  // dump-load-controller
  "connectMqtt",
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

// Load `scriptName` from the repo root. Returns the script's internals plus the MQTT
// traffic, the RPC calls and the MQTT handlers it installed, so tests can assert on what
// it published, subscribed to, commanded and registered. Each call is a fresh copy with
// fresh state.
function load(scriptName) {
  const published = [];
  const subscribed = [];
  const calls = [];
  const handlers = {};

  const source =
    fs.readFileSync(path.join(REPO_ROOT, scriptName), "utf8") + exportsLine();

  const stubs = {
    Shelly: {
      // Never calls back, so a script's own init() stalls here rather than starting
      // timers. The record is what a test asserts a controller did.
      call: function (method, params) { calls.push({ method: method, params: params }); },
      addStatusHandler: function () {},
      addEventHandler: function () {},
      getComponentStatus: function () { return null; },
      getComponentConfig: function () { return null; },
    },
    MQTT: {
      subscribe: function (topic) { subscribed.push(topic); },
      publish: function (topic, payload) { published.push({ topic, payload }); },
      setConnectHandler: function (fn) { handlers.connect = fn; },
      setDisconnectHandler: function (fn) { handlers.disconnect = fn; },
    },
    Timer: {
      set: function () { return 1; },
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

  return { mod, published, subscribed, calls, handlers };
}

module.exports = { load };
