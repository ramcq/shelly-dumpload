// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Tests for dhw-controller.js. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog, advanceClock, uptimeMs, withJumpedWallClock } =
  require("./harness.js");

const DHW = "dhw-controller.js";

const DHW_ENABLE = "shelly1minig3-48f6ee8e8780"; // .123
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0"; // .209: the heat pump lock
const PORTAL = "c0847dc9a794";

const SECONDS = 1000;
const MINUTES = 60 * SECONDS;

function loadEnable() {
  const loaded = load(DHW, DHW_ENABLE);
  assert.strictEqual(loaded.mod.state.identityKnown, true,
    "the script did not recognise the device it is written for");
  return loaded;
}

function victron(mod, key, value) {
  mod.processMqttMessage(
    "N/" + PORTAL + "/" + mod.config.topics[key],
    JSON.stringify({ value: value }));
}

// .209's status: closed means the heat pump runs, open means shortage.
function lock(mod, closed) {
  mod.processMqttMessage(HP_LOCK, JSON.stringify({ id: 0, output: closed }));
}

function bufferTop(mod, degrees) {
  victron(mod, "bufferTop", degrees);
}

function boilerFlow(mod, degrees) {
  victron(mod, "boilerFlow", degrees);
}

// dbus-froeling's /Connected.
function bridge(mod, connected) {
  victron(mod, "froelingConnected", connected ? 1 : 0);
}

// The DHW time clock, on the device's own input.
function timeClock(mod, calling) {
  mod.state.inputIsActive = calling;
}

// A synchronised clock reading `hhmm` local.
function clockAt(hhmm) {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { uptime: uptimeMs() / 1000,
          time: hhmm, unixtime: 1756000000, last_sync_ts: 1755999000 }
      : null;
  };
}

// No NTP sync: sys.time is null.
function clockUnsynchronised() {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { uptime: uptimeMs() / 1000, time: null, unixtime: null, last_sync_ts: null }
      : null;
  };
}

// Shortage, the 05:00 slot, a hot buffer and no entry window.
function windowConditions(mod) {
  clockAt("05:20");
  lock(mod, false);
  mod.state.entryWindowUntilUptime = null;
  bufferTop(mod, 65);
  boilerFlow(mod, 68);
}

// The relay as found, not as commanded by this run.
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
}

function pastStartupGrace(mod) {
  advanceClock(mod.config.startupGrace + 1000);
  mod.refreshUptime();
}

// Switch.Set commands sent; Shelly.call never calls back under the harness.
function switchCommands(calls) {
  return calls
    .filter((c) => c.method === "Switch.Set")
    .map((c) => c.params.on);
}

function statusText(mod) {
  return captureLog(function () { mod.updateStatus(); });
}

function bannerText(mod) {
  return captureLog(function () { mod.finishSetup(); });
}

// ===== Which device this belongs on =====

test("the script runs only on the device it was written for", () => {
  // .164: next door, and its relay looks identical.
  const { mod, calls, timers } = load(DHW, "shelly1minig3-d885ac0818d0");

  assert.strictEqual(mod.state.identityKnown, false);
  assert.deepStrictEqual(calls, [], "a device with no role created components");
  assert.deepStrictEqual(timers, [], "a device with no role scheduled work");
});

test("no relay is commanded before the role is known", () => {
  const { mod, calls } = load(DHW, "shelly1minig3-d885ac0818d0");
  settle(mod, true);
  windowConditions(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

// ===== What it subscribes to =====
// A script may hold ten subscriptions; the eleventh stops it running.

test("it follows the lock rather than deriving shortage", () => {
  const { mod, subscribed } = loadEnable();
  mod.handleMqttConnected();

  assert.deepStrictEqual(subscribed.sort(), [
    "N/" + PORTAL + "/temperature/100/Temperature",
    "N/" + PORTAL + "/temperature/103/Temperature",
    "N/" + PORTAL + "/temperature/100/Connected",
    HP_LOCK
  ].sort());
  assert.ok(subscribed.length <= 10,
    "subscribed to " + subscribed.length + ": " + subscribed.join(", "));
});

test("the time clock is read from the device's own input, not over MQTT", () => {
  const { mod, subscribed } = loadEnable();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf(DHW_ENABLE + "/status/input:0") < 0,
    "the one path that must survive a dead network was taken over the network");
});

// ===== Rung 1: the time clock, which is not second-guessed =====

test("the time clock closes the enable with nothing else known at all", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  timeClock(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the clock is not weighed against the buffer", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  lock(mod, true);
  bufferTop(mod, 20);
  boilerFlow(mod, 18);
  timeClock(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a clock the hardware has already answered is not commanded again", () => {
  // A Switch.Set overrides `follow` until the next input edge.
  const { mod, calls } = loadEnable();
  settle(mod, true);
  timeClock(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a window expiring underneath the clock does not cancel it", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true], "the window never opened");
  settle(mod, true);

  timeClock(mod, true);   // the user turns the clock on at 05:30
  clockAt("06:05");       // and the slot ends underneath it
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true], "the clock's request was cancelled");
});

// ===== Rung 2: the shortage DHW window =====

test("nothing takes DHW from the buffer outside shortage", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("05:20");
  lock(mod, true);
  bufferTop(mod, 75);
  boilerFlow(mod, 78);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a lock never heard from opens no window", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("05:20");
  bufferTop(mod, 75);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a window opens in shortage, on the hour, with the buffer hot", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("windows are one hour in six, not any hour that happens to be hot", () => {
  ["05:40", "11:00", "17:59", "23:30"].forEach((at) => {
    const { mod, calls } = loadEnable();
    settle(mod, false);
    windowConditions(mod);
    clockAt(at);
    mod.checkSystemState();
    assert.deepStrictEqual(switchCommands(calls), [true], at + " opened no window");
  });

  // 08 and 09 catch an hour parsed as octal.
  ["04:59", "06:00", "08:30", "09:15", "12:00", "16:30", "22:00", "00:10"].forEach((at) => {
    const { mod, calls } = loadEnable();
    settle(mod, false);
    windowConditions(mod);
    clockAt(at);
    mod.checkSystemState();
    assert.deepStrictEqual(switchCommands(calls), [], at + " is not a slot");
  });
});

// ===== The guard: buffer temperature =====

test("a cold buffer gets no window, however short the system is", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 45);
  boilerFlow(mod, 40);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("boiler flow opens a window the buffer top has not caught up with", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 42);
  boilerFlow(mod, 72);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("buffer top opens a window on a boiler that stopped hours ago", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 68);
  boilerFlow(mod, 30);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a temperature that has never arrived is not read as cold", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("05:20");
  lock(mod, false);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
  assert.ok(mod.outstandingReadings().indexOf("the buffer top") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the boiler flow") >= 0);
});

test("a window is a slot, not a start time", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("05:00");
  lock(mod, false);
  bufferTop(mod, 40);
  boilerFlow(mod, 35);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [], "a cold buffer opened a window");

  clockAt("05:20");
  boilerFlow(mod, 64);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

// ===== The latch =====

test("an enable that has closed within a slot stays closed for the rest of it", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
  settle(mod, true);

  bufferTop(mod, 55);   // the burn ends and the buffer falls back through the guard
  boilerFlow(mod, 45);
  clockAt("05:50");
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true], "the window was withdrawn mid-slot");
});

test("the latch is cleared with the hour", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();
  settle(mod, true);
  bufferTop(mod, 55);
  boilerFlow(mod, 45);

  clockAt("06:00");
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true, false]);
  assert.strictEqual(mod.state.windowLatched, false);
});

test("shortage ending ends the window, latch and all", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();
  settle(mod, true);

  lock(mod, true);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true, false]);
  assert.strictEqual(mod.state.windowLatched, false);
});

test("the guard does not latch ahead of the check that acts on it", () => {
  // The lock edge only updates the window key; the poll latches.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("05:20");
  bufferTop(mod, 65);
  boilerFlow(mod, 68);

  lock(mod, false);

  assert.strictEqual(mod.state.windowKey, "05:00", "the window key was not refreshed");
  assert.strictEqual(mod.state.windowLatched, false, "the guard latched before the poll");
  assert.deepStrictEqual(switchCommands(calls), []);

  mod.checkSystemState();

  assert.strictEqual(mod.state.windowLatched, true);
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

// ===== The window on entering shortage =====

test("entering shortage opens a window there and then", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  bufferTop(mod, 70);
  boilerFlow(mod, 72);
  lock(mod, true);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [], "a window opened outside shortage");

  lock(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the entry window is guarded like any other", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  bufferTop(mod, 40);
  boilerFlow(mod, 35);

  lock(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the entry window lasts an hour", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  bufferTop(mod, 70);
  boilerFlow(mod, 72);
  lock(mod, false);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
  settle(mod, true);

  advanceClock(mod.config.window.entryWindowLength + 1000);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true, false]);
});

test("an entry window running into a scheduled slot is one window, not two", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockAt("04:40");
  bufferTop(mod, 70);
  boilerFlow(mod, 72);
  lock(mod, false);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
  settle(mod, true);

  bufferTop(mod, 50);   // the burn ends before the slot begins
  boilerFlow(mod, 45);
  clockAt("05:00");
  mod.state.entryWindowUntilUptime = mod.state.nowUptime + (20 * MINUTES);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true],
    "the enable was withdrawn between two windows that touch");
  assert.strictEqual(mod.state.windowKey, "05:00");
});

test("a shortage that has already begun is not re-entered on every lock message", () => {
  // .209 republishes its status on every reconnect.
  const { mod } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  lock(mod, false);
  const openedAt = mod.state.entryWindowUntilUptime;
  assert.ok(openedAt !== null);

  mod.state.entryWindowUntilUptime = openedAt - (30 * MINUTES);
  lock(mod, false);

  assert.strictEqual(mod.state.entryWindowUntilUptime, openedAt - (30 * MINUTES),
    "a republish restarted the entry window");
});

// ===== The bridge falling over =====

test("a held temperature is not a reading", () => {
  // dbus-froeling holds its last value when Modbus drops; /Connected says so.
  const { mod } = loadEnable();
  windowConditions(mod);
  assert.strictEqual(mod.guardTemperature(), 68);

  bridge(mod, false);

  assert.strictEqual(mod.guardTemperature(), null,
    "a buffer nobody can read was still guarding the window");
});

test("a blind window runs anyway", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);

  bridge(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
  assert.strictEqual(mod.state.windowBlind, true);
});

test("a blind window keeps to its slots rather than running on", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bridge(mod, false);
  clockAt("07:30");
  mod.state.entryWindowUntilUptime = null;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the boiler release is .164's business, not this controller's", () => {
  const { mod, subscribed } = loadEnable();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf("shelly1minig3-d885ac0818d0/status/switch:0") < 0,
    subscribed.join(", "));
});

test("nothing runs blind outside shortage", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  lock(mod, true);

  bridge(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a bridge that comes back is guarded again", () => {
  const { mod } = loadEnable();
  windowConditions(mod);
  bridge(mod, false);
  assert.strictEqual(mod.bufferUnreadable(), true);

  bridge(mod, true);

  assert.strictEqual(mod.bufferUnreadable(), false);
  assert.strictEqual(mod.guardTemperature(), 68);
});

test("silence is blindness only past the grace, but being told is immediate", () => {
  const told = loadEnable();
  told.mod.state.listeningSinceUptime = told.mod.state.nowUptime;
  bridge(told.mod, false);
  assert.strictEqual(told.mod.bufferUnreadable(), true,
    "being told was not believed at once");

  const silent = loadEnable();
  silent.mod.state.listeningSinceUptime = silent.mod.state.nowUptime;
  assert.strictEqual(silent.mod.bufferUnreadable(), false,
    "a controller that had just started gave up on readings still in flight");

  pastStartupGrace(silent.mod);
  assert.strictEqual(silent.mod.bufferUnreadable(), true,
    "a bridge that never said anything at all was waited on indefinitely");
});

test("the silence grace runs from the reconnect, not from script start", () => {
  // Up for days, so a grace from boot would have expired long ago.
  const { mod } = loadEnable();
  advanceClock(5 * 24 * 60 * MINUTES);
  windowConditions(mod);
  bridge(mod, true);

  mod.resetMqttData();
  mod.handleMqttConnected();

  assert.strictEqual(mod.bufferUnreadable(), false,
    "gave up on temperatures that were still in flight");

  bufferTop(mod, 35);
  boilerFlow(mod, 30);
  mod.checkSystemState();

  assert.strictEqual(mod.state.windowLatched, false);
});

test("a blind window is named as one", () => {
  const { mod } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bridge(mod, false);
  mod.checkSystemState();

  const text = statusText(mod);
  assert.ok(text.indexOf("Buffer ?") >= 0, text);
  assert.ok(text.indexOf("blind") >= 0, text);
});

test("the guard still decides while the bridge is up", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 45);
  boilerFlow(mod, 40);
  bridge(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the bridge state is asked for, being silent between transitions", () => {
  const { mod, subscribed, published, timers } = loadEnable();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf("N/" + PORTAL + "/temperature/100/Connected") >= 0,
    subscribed.join(", "));
  assert.ok(subscribed.length <= 10, "subscribed to " + subscribed.length);

  const keepalive = timers.filter((t) => t.repeat === true).pop();
  bufferTop(mod, 70);
  boilerFlow(mod, 70);
  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "",
    "stopped asking for a republish before the bridge state had ever arrived");

  bridge(mod, true);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0, published[0].payload);
});

// ===== A clock the device did not invent =====

test("a device that has never synchronised runs no scheduled slots", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  lock(mod, false);
  bufferTop(mod, 75);
  boilerFlow(mod, 78);
  clockUnsynchronised();
  mod.state.entryWindowUntilUptime = null;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the entry window works without one, because it is an interval rather than a time", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  clockUnsynchronised();
  bufferTop(mod, 75);
  boilerFlow(mod, 78);

  lock(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

// ===== A restart, with the enable already closed =====

test("a redeploy does not open an enable before the readings arrive", () => {
  const { mod, calls } = loadEnable();
  settle(mod, true);
  clockAt("05:20");

  assert.notStrictEqual(mod.outstandingReadings(), "");
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "every redeploy would shut the zone valves on a live window");
});

test("past the grace, silence is taken at face value", () => {
  const { mod, calls } = loadEnable();
  settle(mod, true);
  clockAt("05:20");
  pastStartupGrace(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("the readings it waits for are the ones that could justify an enable", () => {
  const { mod } = loadEnable();

  assert.ok(mod.outstandingReadings().indexOf("the heat pump lock") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the buffer top") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the boiler flow") >= 0);

  lock(mod, true);
  bufferTop(mod, 50);
  boilerFlow(mod, 50);
  assert.strictEqual(mod.outstandingReadings(), "");
});

test("a restart inside a live window re-latches it rather than reconstructing one", () => {
  // The relay is the state; nothing is reconstructed.
  const { mod, calls } = loadEnable();
  settle(mod, true);
  windowConditions(mod);
  pastStartupGrace(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
  assert.strictEqual(mod.state.windowLatched, true);
});

// ===== What it says it is doing =====

test("the status line names the relay and which way its contact is", () => {
  const { mod } = loadEnable();
  settle(mod, false);

  assert.ok(statusText(mod).indexOf("DHW Enable OFF") >= 0, statusText(mod));
});

test("it claims no reading it has not been given", () => {
  const { mod } = loadEnable();
  settle(mod, false);
  const text = statusText(mod);

  assert.ok(text.indexOf("HP ?") >= 0, text);
  assert.ok(text.indexOf("Buffer ?") >= 0, text);
  assert.ok(text.indexOf("Flow ?") >= 0, text);
});

test("the status line says which rung closed the enable", () => {
  const { mod } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();

  const text = statusText(mod);
  assert.ok(text.indexOf("Enabled: shortage DHW window (05:00)") >= 0, text);
});

test("the banner states the numbers that decide when heat leaves the buffer", () => {
  const { mod } = loadEnable();
  const banner = bannerText(mod);

  assert.ok(banner.indexOf("60") >= 0, banner);
  assert.ok(banner.indexOf("05:00") >= 0, banner);
});

// ===== The plumbing under all of it =====

test("status notifications are turned on if the device has them off", () => {
  // .164 reads this device's input.
  const { mod, calls } = loadEnable();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: false };
  };

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1);
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured or rebooted", () => {
  const { mod, calls } = loadEnable();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: true };
  };

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "a settled device must not reboot on every script start");
});

test("a disconnect handler is installed even when MQTT is already connected", () => {
  const { mod, handlers } = loadEnable();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: true };
  };

  mod.connectMqtt();

  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");
});

test("the lock is asked to republish, once the subscriptions are in", () => {
  // Shelly status is not retained.
  const { mod, published, timers } = loadEnable();
  mod.handleMqttConnected();

  assert.deepStrictEqual(published, [], "asked before anything was listening");

  const initial = timers.filter((t) => t.repeat === false).pop();
  assert.ok(initial, "no initial republish request was scheduled");
  initial.fn();

  assert.ok(published.some((p) =>
    p.topic === "shelly1minig3-d885ac0a3668/command" && p.payload === "status_update"),
    JSON.stringify(published));
});

test("it keeps asking until the lock answers", () => {
  const { mod, published, timers } = loadEnable();
  mod.handleMqttConnected();
  const keepalive = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  keepalive.fn();
  assert.ok(published.some((p) => p.payload === "status_update"));

  lock(mod, true);
  published.length = 0;
  keepalive.fn();
  assert.ok(!published.some((p) => p.payload === "status_update"),
    "kept asking for an answer it already had");
});

test("keepalives ask for a full republish until both temperatures arrive", () => {
  const { mod, published, timers } = loadEnable();
  mod.handleMqttConnected();
  const keepalive = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "", "did not ask the Cerbo to republish");

  bufferTop(mod, 50);
  boilerFlow(mod, 50);
  bridge(mod, true);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0, published[0].payload);
});

test("a broker drop forgets the temperatures and keeps the lock", () => {
  const { mod } = loadEnable();
  lock(mod, false);
  bufferTop(mod, 70);
  boilerFlow(mod, 72);

  mod.resetMqttData();

  assert.strictEqual(mod.state.lockKnown, true);
  assert.strictEqual(mod.state.lockIsClosed, false);
  assert.strictEqual(mod.state.bufferTopReceived, false);
  assert.strictEqual(mod.state.boilerFlowReceived, false);
});

test("a drop mid-window does not withdraw the window it was already holding", () => {
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  mod.checkSystemState();
  settle(mod, true);

  mod.resetMqttData();
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

// ===== The clock jumping =====
// The entry window is measured on uptime. See docs/adr/0003.

test("NTP landing does not cancel an entry window", () => {
  const { mod } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  lock(mod, false);
  assert.strictEqual(mod.state.windowKey, "entry");

  withJumpedWallClock(function () { mod.checkSystemState(); });

  assert.strictEqual(mod.currentWindowKey(), "entry",
    "an hour measured on the wall clock ended the moment NTP landed");
});

test("the entry window still ends, on the clock that cannot jump", () => {
  const { mod } = loadEnable();
  settle(mod, false);
  clockAt("07:30");
  lock(mod, false);

  advanceClock(mod.config.window.entryWindowLength + 1000);
  mod.checkSystemState();

  assert.strictEqual(mod.currentWindowKey(), "");
});
