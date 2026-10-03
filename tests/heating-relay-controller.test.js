// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Boiler Release (.164). Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog, advanceClock, uptimeMs, withJumpedWallClock } =
  require("./harness.js");

const HEATING = "heating-relay-controller.js";

const BOILER_RELEASE = "shelly1minig3-d885ac0818d0"; // .164
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0"; // .209's relay
const DHW_CLOCK = "shelly1minig3-48f6ee8e8780/status/input:0"; // .123's input
const PORTAL = "c0847dc9a794";

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

const RUNNING = 10; // digitalinput/102/State
const STOPPED = 11;

// A Sunday that is an exercise day: UTC day 20163 (2025-03-16), 20163 % 14 === 3.
const SLOT_DAY_S = 20163 * 86400;

function loadRelease() {
  const loaded = load(HEATING, BOILER_RELEASE);
  assert.strictEqual(loaded.mod.state.identityKnown, true);
  return loaded;
}

function lock(mod, closed) {
  mod.processMqttMessage(HP_LOCK, JSON.stringify({ id: 0, output: closed }));
}

function dhwClock(mod, calling) {
  mod.processMqttMessage(DHW_CLOCK, JSON.stringify({ id: 0, state: calling }));
}

function boiler(mod, running) {
  mod.processMqttMessage("N/" + PORTAL + "/" + mod.config.topics.boilerOperating,
    JSON.stringify({ value: running ? RUNNING : STOPPED }));
}

function heardEverything(mod) {
  lock(mod, true);
  dhwClock(mod, false);
  boiler(mod, false);
}

function wait(mod, ms) {
  advanceClock(ms);
  mod.refreshUptime();
}

// A synchronised wall clock at `unixSeconds`, showing local time `hhmm`.
function wallClock(unixSeconds, hhmm, synced) {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { uptime: uptimeMs() / 1000, unixtime: unixSeconds, time: hhmm,
          last_sync_ts: synced === false ? null : unixSeconds - 800 }
      : null;
  };
}

// The relay as found at startup rather than released by this run.
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
  mod.state.releasedAtUptime = null;
}

function switchCommands(calls) {
  return calls.filter((c) => c.method === "Switch.Set").map((c) => c.params.on);
}

function statusText(mod) {
  return captureLog(function () { mod.updateStatus(); });
}

// ===== Identity and subscriptions =====

test("the script runs only on the device it was written for", () => {
  const { mod, calls, timers } = load(HEATING, "shelly1minig3-48f6ee8e8780");

  assert.strictEqual(mod.state.identityKnown, false);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(timers, []);
});

test("no relay is commanded before the role is known", () => {
  const { mod, calls } = load(HEATING);
  mod.state.inputIsActive = true;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("subscribes to the lock, .123's input and the boiler input only", () => {
  const { mod, subscribed } = loadRelease();
  mod.handleMqttConnected();

  assert.deepStrictEqual(subscribed.sort(), [
    "N/" + PORTAL + "/digitalinput/102/State",
    DHW_CLOCK,
    HP_LOCK
  ].sort());
});

// ===== Rungs 1 and 2 =====

test("H1 releases the boiler", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  mod.state.inputIsActive = true;
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("an H1 the hardware has already answered is not commanded again", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);
  mod.state.inputIsActive = true;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a DHW demand releases the boiler", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  dhwClock(mod, true);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

// ===== Rung 3: shortage =====

test("the lock open for thirty minutes releases the boiler", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  lock(mod, false);
  wait(mod, 29 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), []);

  wait(mod, 2 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
  assert.strictEqual(mod.releaseReason(), "shortage");
});

test("a generator test run does not release the boiler", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  lock(mod, false);
  wait(mod, 23 * MINUTES);
  lock(mod, true);
  wait(mod, 10 * MINUTES);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
  assert.strictEqual(mod.state.lockOpenSinceUptime, null);
});

test("a lock never heard from releases nothing", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  dhwClock(mod, false);
  wait(mod, 2 * HOURS);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a broker drop keeps the lock and its timer", () => {
  const { mod } = loadRelease();
  heardEverything(mod);
  lock(mod, false);
  const since = mod.state.lockOpenSinceUptime;
  dhwClock(mod, true);

  mod.resetMqttData();
  wait(mod, 5 * MINUTES);
  lock(mod, false); // the republish after reconnecting

  assert.strictEqual(mod.state.dhwDemandReceived, false);
  assert.strictEqual(mod.state.lockKnown, true);
  assert.strictEqual(mod.state.lockOpenSinceUptime, since);
});

test("NTP landing does not shorten the thirty minutes", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  lock(mod, false);

  withJumpedWallClock(function () { mod.checkSystemState(); });

  assert.deepStrictEqual(switchCommands(calls), []);
});

// ===== Rung 4: the exercise run =====

test("the exercise slot releases the boiler", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  wallClock(SLOT_DAY_S + 10 * 3600, "11:05");

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
  assert.strictEqual(mod.releaseReason(), "exercise run");
});

test("outside the slot hour or day there is no exercise run", () => {
  const { mod } = loadRelease();
  heardEverything(mod);

  wallClock(SLOT_DAY_S + 11 * 3600, "12:05");
  assert.strictEqual(mod.exerciseDue(), false);

  wallClock(SLOT_DAY_S + 7 * 86400 + 10 * 3600, "11:05");
  assert.strictEqual(mod.exerciseDue(), false, "the slot is every other week");
});

test("an unsynchronised clock runs no exercise", () => {
  const { mod } = loadRelease();
  wallClock(SLOT_DAY_S + 10 * 3600, "11:05", false);

  assert.strictEqual(mod.exerciseDue(), false);
});

test("an ignition in the last fourteen days skips the slot", () => {
  const { mod } = loadRelease();
  boiler(mod, false);
  boiler(mod, true);
  wait(mod, 13 * DAYS);
  wallClock(SLOT_DAY_S + 10 * 3600, "11:05");

  assert.strictEqual(mod.exerciseDue(), false);

  wait(mod, 1 * DAYS);
  wallClock(SLOT_DAY_S + 10 * 3600, "11:05");
  assert.strictEqual(mod.exerciseDue(), true);
});

test("the first boiler reading is not an ignition", () => {
  const { mod } = loadRelease();
  boiler(mod, true);

  assert.strictEqual(mod.state.lastIgnitionUptime, null);
});

test("the exercise run lasts the minimum on time", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  wallClock(SLOT_DAY_S + 10 * 3600 + 3000, "11:50");
  mod.checkSystemState();
  mod.state.relayIsOn = true;

  wait(mod, 20 * MINUTES);
  wallClock(SLOT_DAY_S + 11 * 3600 + 600, "12:10");
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);

  wait(mod, 41 * MINUTES);
  wallClock(SLOT_DAY_S + 11 * 3600 + 3060, "12:51");
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true, false]);
});

// ===== Holding and dropping =====

test("a release this script made stands for an hour", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  dhwClock(mod, true);
  mod.checkSystemState();
  mod.state.relayIsOn = true;

  dhwClock(mod, false);
  wait(mod, 5 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);

  withJumpedWallClock(function () { mod.checkSystemState(); });
  assert.deepStrictEqual(switchCommands(calls), [true]);

  wait(mod, 56 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true, false]);
});

test("a relay found closed is dropped once nothing asks for it", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);
  heardEverything(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("a relay found closed waits for the lock and the DHW clock", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), []);

  wait(mod, mod.config.startupGrace + 1000);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false]);
});

// ===== Status =====

test("the status line shows the relay, the lock and the reason", () => {
  const { mod } = loadRelease();
  settle(mod, false);
  dhwClock(mod, false);
  boiler(mod, false);
  lock(mod, false);
  wait(mod, 31 * MINUTES);

  const text = statusText(mod);
  assert.ok(text.indexOf("Boiler Release OFF") >= 0, text);
  assert.ok(text.indexOf("HP Locked 31m") >= 0, text);
  assert.ok(text.indexOf("Released: shortage") >= 0, text);
});

test("it claims no reading it has not been given", () => {
  const { mod } = loadRelease();

  const text = statusText(mod);
  assert.ok(text.indexOf("HP ?") >= 0, text);
  assert.ok(text.indexOf("Boiler ?") >= 0, text);
  assert.ok(text.indexOf("DHW ?") >= 0, text);
});

// ===== MQTT =====

function connectedWith(mqttConfig) {
  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () { return mqttConfig; };
}

test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadRelease();
  connectedWith({ enable: true, server: "192.168.1.71:1883", status_ntf: false });

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1);
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured", () => {
  const { mod, calls, handlers } = loadRelease();
  connectedWith({ enable: true, server: "192.168.1.71:1883", status_ntf: true });

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), []);
  assert.strictEqual(typeof handlers.disconnect, "function");
});

function statusUpdates(published, commandTopic) {
  return published.filter((p) => p.topic === commandTopic && p.payload === "status_update");
}

test("the first republish requests wait for the subscriptions", () => {
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();
  assert.deepStrictEqual(published, []);

  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(published[0].payload, "");
  assert.strictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic).length, 1);
  assert.strictEqual(statusUpdates(published, mod.config.dhwClock.commandTopic).length, 1);
});

test("keepalives keep asking until each silent reading arrives", () => {
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();
  const periodic = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  periodic.fn();
  assert.strictEqual(published[0].payload, "");
  assert.strictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic).length, 1);

  heardEverything(mod);
  published.length = 0;
  periodic.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0);
  assert.strictEqual(published.length, 1);
});
