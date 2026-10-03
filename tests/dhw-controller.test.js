// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// DHW Enable (.123). This relay permits heat to move from the buffer into the
// cylinders, and the two things it must never get wrong are opposite in kind: the
// time clock is the user physically asking for hot water and may not be
// second-guessed against anything arriving over MQTT, while a shortage DHW window
// on a cold buffer circulates through the coils and strips heat back *out* of the
// cylinders. So the cases that matter are a window judged against a reading that
// has not arrived, a guard that drops mid-slot, and a clock whose request a window
// expiring underneath it cancels. Run with:
// node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog, advanceClock, uptimeMs, withJumpedWallClock } =
  require("./harness.js");

const DHW = "dhw-controller.js";

const DHW_ENABLE = "shelly1minig3-48f6ee8e8780"; // .123, the only device this runs on
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0"; // .209's relay: the lock
const PORTAL = "c0847dc9a794";

const SECONDS = 1000;
const MINUTES = 60 * SECONDS;

// The script as deployed on .123. Reading the device ID is synchronous, so a load gets as
// far as its identity and its topics on its own.
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

// What .209 publishes: its relay closed means the heat pump is running, open is shortage.
function lock(mod, closed) {
  mod.processMqttMessage(HP_LOCK, JSON.stringify({ id: 0, output: closed }));
}

function bufferTop(mod, degrees) {
  victron(mod, "bufferTop", degrees);
}

function boilerFlow(mod, degrees) {
  victron(mod, "boilerFlow", degrees);
}

// What dbus-froeling says about its own modbus connection. On a lost connection it holds the
// last temperature rather than invalidating it — deliberately, so a transient error does not
// read as the boiler stopping — so this path is the only thing that ever says the buffer
// readings have gone stale.
function bridge(mod, connected) {
  victron(mod, "froelingConnected", connected ? 1 : 0);
}

// The DHW time clock, wired to this relay's own input. Hardware `follow` has already acted
// on it by the time the script reads it.
function timeClock(mod, calling) {
  mod.state.inputIsActive = calling;
}

// A synchronised device reading `hhmm` local. sys.time is the local wall clock and is null
// until the device has actually reached an NTP server, which is the distinction the
// scheduled slots rest on.
function clockAt(hhmm) {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { uptime: uptimeMs() / 1000,
          time: hhmm, unixtime: 1756000000, last_sync_ts: 1755999000 }
      : null;
  };
}

// A device that has never reached an NTP server. It still reports a plausible date, which is
// the dangerous shape of wrong, but no local time at all.
function clockUnsynchronised() {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { uptime: uptimeMs() / 1000, time: null, unixtime: null, last_sync_ts: null }
      : null;
  };
}

// In shortage, in the 05:00 slot, with the buffer hot enough to give the cylinders
// something. Everything a scheduled window needs, so that a test can take one thing away.
// The shortage began more than an hour ago, so the slot is the only window in play — the
// one on entering shortage is its own set of tests.
function windowConditions(mod) {
  clockAt("05:20");
  lock(mod, false);
  mod.state.entryWindowUntilUptime = null;
  bufferTop(mod, 65);
  boilerFlow(mod, 68);
}

// The relay as *found* in this position rather than put there by this run.
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
}

function pastStartupGrace(mod) {
  advanceClock(mod.config.startupGrace + 1000);
  mod.refreshUptime(); // as the next entry into the controller would
}

// What the controller commanded its own relay to do, if anything. Shelly.call never calls
// back under the harness, so the command is the observable, not the resulting state.
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
  // .164 is next door in the same cupboard, its relay looks identical, and closing it burns
  // wood. An unrecognised device runs nothing at all.
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
// A Shelly script may hold ten subscriptions; the eleventh throws "Too many
// subscriptions" and the script does not run at all.

test("it follows the lock rather than deriving shortage", () => {
  // Deriving shortage costs SOC, both generation figures and the inverter output on top of
  // the inverter state — four paths, for a script whose job is moving heat between vessels.
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
  // It is this relay's input. Reading it locally is what lets the clock keep working with
  // the Cerbo down, the Fröling stale or the network broken.
  const { mod, subscribed } = loadEnable();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf(DHW_ENABLE + "/status/input:0") < 0,
    "the one path that must survive a dead network was taken over the network");
});

// ===== Rung 1: the time clock, which is not second-guessed =====

test("the time clock closes the enable with nothing else known at all", () => {
  // No lock, no temperatures, no clock: the switch says heat, so heat. This path has to keep
  // working when the Cerbo is down, because it is the user physically asking for hot water.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  timeClock(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the clock is not weighed against the buffer", () => {
  // The user asking for hot water is not second-guessed against a reading. A cold buffer
  // simply means the cylinder stats find nothing to take, which costs the heat loop pump.
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
  // `follow` closed this relay on the input edge. A Switch.Set overrides follow until the
  // next edge, and there is nothing to gain by taking that over.
  const { mod, calls } = loadEnable();
  settle(mod, true);
  timeClock(mod, true);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a window expiring underneath the clock does not cancel it", () => {
  // A window ending at 06:00 must not open an enable the user asked for at 05:30. The clock
  // is the first rung for exactly this.
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
  // The immersions make the same water from the same surplus more directly, and an enable
  // that moves no energy still runs the heat loop pump and mixes a buffer the thermal dump
  // needs stratified.
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
  // An undeployed or unreachable .209 leaves this relay with the time clock in hardware,
  // which is what it had before the Shelly was there.
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
  // 05:00, 11:00, 17:00 and 23:00. A partial charge resumes six hours later, and the annex
  // cylinder is small enough that one shower empties it.
  ["05:40", "11:00", "17:59", "23:30"].forEach((at) => {
    const { mod, calls } = loadEnable();
    settle(mod, false);
    windowConditions(mod);
    clockAt(at);
    mod.checkSystemState();
    assert.deepStrictEqual(switchCommands(calls), [true], at + " opened no window");
  });

  // 08:xx and 09:xx are in here because an hour read as a number rather than compared as
  // text is where a leading zero has historically meant octal.
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
  // The cylinder stats know nothing about the primary side, so a window on a cold buffer
  // circulates through the coils and strips heat back out of the cylinders.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 45);
  boilerFlow(mod, 40);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("boiler flow opens a window the buffer top has not caught up with", () => {
  // Flow is the earliest honest signal and matches the hydraulics; buffer top measures the
  // energy actually stored but lags ignition by 10-15 minutes.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 42);
  boilerFlow(mod, 72);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("buffer top opens a window on a boiler that stopped hours ago", () => {
  // Flow cools when the boiler stops even with 1500 litres of heat behind it, so the two
  // readings answer for each other and the higher one decides.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);
  bufferTop(mod, 68);
  boilerFlow(mod, 30);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a temperature that has never arrived is not read as cold", () => {
  // Zero is a reading nobody sent. With neither path heard from there is no guard to pass.
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
  // A boiler that lifts the buffer past 60 degC at 05:20 still gets a window: the guard is
  // checked throughout the hour rather than at the top of it.
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

// ===== The latch, which is what stops three actuators cycling =====

test("an enable that has closed within a slot stays closed for the rest of it", () => {
  // A burn finishing mid-window would otherwise shut the zone valves, and a buffer
  // hovering at 60 degC would cycle three actuators.
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
  // A window exists because the heat pump cannot make hot water. Once it can, the buffer is
  // not the route to it.
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
  // The lock's own edge refreshes which window this is, and nothing more. A guard latched
  // there would record a buffer that passed up to a poll before the relay moved — and a
  // buffer can fall through 60 °C in between, which is the one thing the guard is for.
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
  // Otherwise a shortage beginning at 07:30 waits until noon for its first hot water.
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
  // The two touch, so the latch carries: a guard that has dropped in between must not shut
  // the valves at the top of the hour it was already open through.
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
  // .209 republishes its whole status on every reconnect, and a republish is not an edge.
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
  // dbus-froeling leaves the last value on D-Bus when modbus drops, so the number keeps
  // arriving and keeps looking fresh. Only /Connected says otherwise.
  const { mod } = loadEnable();
  windowConditions(mod);
  assert.strictEqual(mod.guardTemperature(), 68);

  bridge(mod, false);

  assert.strictEqual(mod.guardTemperature(), null,
    "a buffer nobody can read was still guarding the window");
});

test("a blind window runs anyway", () => {
  // In shortage the buffer is the only route to hot water, and .164 releases the boiler on
  // the same shortage. Cold water is noticed in hours.
  const { mod, calls } = loadEnable();
  settle(mod, false);
  windowConditions(mod);

  bridge(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
  assert.strictEqual(mod.state.windowBlind, true);
});

test("a blind window keeps to its slots rather than running on", () => {
  // Unguarded is not unbounded: the schedule is what stops DHW running indefinitely against
  // the space heating.
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
  // .164 releases the boiler on the same shortage that opens the window, so a second copy
  // of that decision here would exclude nothing and cost a subscription.
  const { mod, subscribed } = loadEnable();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf("shelly1minig3-d885ac0818d0/status/switch:0") < 0,
    subscribed.join(", "));
});

test("nothing runs blind outside shortage", () => {
  // A window is a shortage window first. With the heat pump running, the immersions make the
  // same water more directly.
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
  // An absent reading is not a stale one. A controller that has just started has heard
  // nothing yet and its temperatures are seconds away; a bridge that says it is disconnected
  // has told us something.
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
  // A broker drop clears the temperatures, and the Cerbo's republish takes a moment to
  // deliver them again. On a controller that has been up for days a grace measured from boot
  // expired long ago, and a poll landing in that gap would latch the window blind for the
  // hour — against a buffer that turns out to be cold a second later.
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
  // A released boiler is not a reason to bypass a reading that exists and says 45 °C.
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
  // 05:00 is a wall-clock time, and a device that has not reached an NTP server has no wall
  // clock — only a plausible-looking one, which is the dangerous shape of wrong.
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
  // The relay is the state. Nothing is written down, and the guard either still holds or the
  // window ends early — which is the accepted cost of a late guard.
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
  // .164 reads this device's input for its DHW demand rung. With notifications off, the
  // time clock never leaves the cupboard.
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
  // Shelly status is published on change and not retained, so a follower that has just
  // started believes nothing at all until the lock next moves — which may be months.
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
  // The buffer readings arrive every few seconds, so silence means the controller cannot
  // see them rather than that they have not moved. Silence is not .209 saying the battery
  // recovered.
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
//
// .123 arms an hour-long window on the lock's opening edge. The window is an interval
// within the run, so it is measured on uptime. See docs/adr/0003.

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
