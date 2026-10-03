// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Loads a controller script under stubbed Shelly globals and appends an exports line.
// Shelly.call never calls back, so init() stalls after resolving device identity.

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");

// What tests can reach. A name a script lacks exports undefined.
const EXPORTED = [
  "config",
  "state",
  // surplus-dump-controller
  "calculateDesiredState",
  "calculateAvailablePower",
  "calculateMaxDumpPower",
  "suppressAllLoads",
  "isLoadLocked",
  "isEvChargingInAuto",
  "applyDesiredState",
  "sendRemoteSwitchCommand",
  "getDumpLoadPower",
  // thermal-dump-controller
  "isLoadStalled",
  "setupEventHandlers",
  "getOutput",
  "turnOutputOn",
  "turnOutputOff",
  "updateOutputStates",
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
  "determineDeviceIdentity",
  "finishSetup",
  // heating-relay-controller
  "refreshUptime",
  "releaseReason",
  "shortageDue",
  "exerciseDue",
  "outstandingReadings",
  // dhw-controller
  "localHourText",
  "guardTemperature",
  "guardSatisfied",
  "bridgeIsDown",
  "bufferUnreadable",
  "currentWindowKey",
  "updateWindow",
  "updateWindowGuard",
  "windowOpen",
  "enableReason",
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

// Device uptime clock, owned by the most recent load. Starts at one minute.
const INITIAL_UPTIME_MS = 60 * 1000;
let clockUptimeMs = INITIAL_UPTIME_MS;

// Advance uptime by ms; returns the new uptime.
function advanceClock(ms) {
  clockUptimeMs += ms;
  return clockUptimeMs;
}

// Current uptime in ms.
function uptimeMs() {
  return clockUptimeMs;
}

// `sys` status: uptime only. No unixtime/last_sync_ts, so the wall clock reads unsynced.
function sysStatus() {
  return { uptime: clockUptimeMs / 1000 };
}

// Load a fresh copy of `scriptName` as if on `deviceId` (default: no role).
// Returns its exports and recorded MQTT, RPC calls, timers and handlers.
function load(scriptName, deviceId) {
  const published = [];
  const subscribed = [];
  const calls = [];
  const timers = [];
  const handlers = {};

  // Fresh clock per load.
  clockUptimeMs = INITIAL_UPTIME_MS;

  // Only `sys` has a status.
  function deviceStatus(key) {
    return key === "sys" ? sysStatus() : null;
  }

  const source =
    fs.readFileSync(path.join(REPO_ROOT, scriptName), "utf8") + exportsLine();

  const stubs = {
    Shelly: {
      // Recorded, never called back; a test may invoke cb itself.
      call: function (method, params, cb) { calls.push({ method, params, cb }); },
      // Recorded so a test can deliver device events.
      addStatusHandler: function (fn) { handlers.status = fn; },
      addEventHandler: function (fn) { handlers.event = fn; },
      getComponentStatus: function (key) { return deviceStatus(key); },
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
      // Recorded, not run.
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

  // Distinct temp filename bypasses the require cache: fresh state per load.
  const tmp = path.join(
    os.tmpdir(),
    "shelly-under-test-" + process.pid + "-" + loadCounter++ + ".js"
  );
  fs.writeFileSync(tmp, source);

  // Stubs stay installed; the script uses them after load too.
  Object.assign(global, stubs);

  let mod;
  try {
    mod = require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }

  return { mod, published, subscribed, calls, timers, handlers };
}

// Run fn with Date.now jumped twelve days ahead, as when NTP lands after boot.
function withJumpedWallClock(fn) {
  const real = Date.now;
  Date.now = function () { return real() + 12 * 24 * 60 * 60 * 1000; };
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

// Run fn and return what it logged; the status line is only observable here.
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

module.exports = { load, captureLog, advanceClock, uptimeMs, withJumpedWallClock };
