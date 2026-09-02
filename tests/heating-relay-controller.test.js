// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Boiler Release (.164). Every test here is about the cost of being wrong in one
// direction: releasing the boiler burns wood that cannot be un-burnt, and the four
// rungs that release it are not equally sure of themselves. So the cases that matter
// are the ones where a rung looks satisfied and is not — a generator start reaching
// the rung below it, a fourteen-day timer read off a clock that has never
// synchronised, a fire lit on a power system nobody can read. Run with:
// node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog } = require("./harness.js");

const HEATING = "heating-relay-controller.js";

const BOILER_RELEASE = "shelly1minig3-d885ac0818d0"; // .164, the only device this runs on
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0"; // .209's relay: the lock
const DHW_CLOCK = "shelly1minig3-48f6ee8e8780/status/input:0"; // .123's input: the time clock
const PORTAL = "c0847dc9a794";

const INVERTING = 9;
const PASSTHRU = 8;
const BULK = 3;

const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

const RUNNING = 10; // digitalinput/102/State
const STOPPED = 11;

// The script as deployed on .164. Reading the device ID is synchronous, so a load gets as
// far as its identity and its topics on its own.
function loadRelease() {
  const loaded = load(HEATING, BOILER_RELEASE);
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

// What .123 publishes when the DHW time clock moves. Its input, not its relay: the relay
// also closes for a shortage DHW window, which asks for no heat and releases nothing.
function dhwClock(mod, calling) {
  mod.processMqttMessage(DHW_CLOCK, JSON.stringify({ id: 0, state: calling }));
}

function boiler(mod, running) {
  victron(mod, "boilerOperating", running ? RUNNING : STOPPED);
}

// The inverter has been off-grid abnormal for `ms`. The reading itself starts that clock, so
// a test that wants it to have been running a while says so afterwards.
function vebusShortFor(mod, vebusState, ms) {
  victron(mod, "vebusState", vebusState);
  mod.state.vebusShortSince = Date.now() - ms;
}

// A controller that has heard from everything it follows, with none of it asking for heat.
// A restart that has heard none of it leaves the relay alone instead, which is its own test.
function heardEverything(mod) {
  victron(mod, "vebusState", INVERTING);
  lock(mod, true);
  dhwClock(mod, false);
  boiler(mod, false);
}

// A synchronised clock reading `at`, in ms. The exercise run is the one rung that spans a
// reboot, so it is the only one that asks for a clock rather than timing an interval.
function clockAt(at) {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { unixtime: Math.floor(at / 1000), last_sync_ts: Math.floor(at / 1000) - 800 }
      : null;
  };
}

// A device that has never reached an NTP server. It still reports a date — the plausible
// wrong answer is the dangerous one, not the obviously absent one.
function clockUnsynchronised(at) {
  global.Shelly.getComponentStatus = function (key) {
    return key === "sys"
      ? { unixtime: Math.floor((at || 0) / 1000), last_sync_ts: null }
      : null;
  };
}

// The relay as *found* in this position rather than put there by this run, which is what
// clears the minimum on time: that rule is about not undoing this script's own decision.
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
  mod.state.releasedAt = 0;
}

function pastStartupGrace(mod) {
  mod.state.startedAt = Date.now() - (mod.config.startupGrace + 1000);
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
  // A misdirected deploy must not command someone else's relay. .123 is next door in the
  // same cupboard, wired in series with the DHW time clock, and its relay looks identical.
  const { mod, calls, timers } = load(HEATING, "shelly1minig3-48f6ee8e8780");

  assert.strictEqual(mod.state.identityKnown, false);
  assert.deepStrictEqual(calls, [], "a device with no role created components");
  assert.deepStrictEqual(timers, [], "a device with no role scheduled work");
});

test("identity is resolved before anything else runs", () => {
  const { mod, calls } = loadRelease();

  assert.strictEqual(mod.state.deviceName, "Boiler Release");
  assert.strictEqual(calls[0].method, "Shelly.GetComponents",
    "startup does something before it knows which device it is on");
});

test("no relay is commanded before the role is known", () => {
  const { mod, calls } = load(HEATING); // identity deliberately unresolved
  mod.state.inputIsActive = true;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

// ===== What it subscribes to =====
// A Shelly script may hold ten subscriptions; the eleventh throws "Too many
// subscriptions" and the script does not run at all.

test("stays well within Shelly's ten-subscription cap", () => {
  const { mod, subscribed } = loadRelease();
  mod.handleMqttConnected();

  assert.ok(subscribed.length <= 10,
    "subscribed to " + subscribed.length + ": " + subscribed.join(", "));
});

test("it follows the lock rather than deriving shortage", () => {
  // Deriving it needs SOC and both generation figures on top of the inverter state.
  // Following .209 costs one subscription and no knowledge of the battery — see ADR 0001.
  const { mod, subscribed } = loadRelease();
  mod.handleMqttConnected();

  assert.deepStrictEqual(subscribed.sort(), [
    "N/" + PORTAL + "/digitalinput/102/State",
    "N/" + PORTAL + "/vebus/276/State",
    DHW_CLOCK,
    HP_LOCK
  ].sort());
});

test("the DHW rung follows the time clock, not .123's relay", () => {
  // .123's relay also closes for a shortage DHW window, which exists because the heat is
  // already there. Releasing the boiler on one would be asking for heat on the grounds of
  // having some.
  const { mod, subscribed } = loadRelease();
  mod.handleMqttConnected();

  assert.ok(subscribed.indexOf(DHW_CLOCK) >= 0);
  assert.ok(subscribed.indexOf("shelly1minig3-48f6ee8e8780/status/switch:0") < 0,
    "a shortage DHW window would read as a request for heat");
});

// ===== Rung 1: H1, the winter bivalent, which is not a power system term at all =====

test("H1 releases the boiler on its own", () => {
  // At -1 degC the biomass supplements a heat pump that is still running. Wiring the two as
  // strict inverses silently disables the behaviour the system was commissioned for.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod); // the heat pump is running, and H1 is still asking

  mod.state.inputIsActive = true;
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("an H1 the hardware has already answered is not commanded again", () => {
  // The relay is `follow`, so H1 closes it without the script. A Switch.Set overrides
  // follow until the next input edge, so the script has nothing to gain by issuing one.
  const { mod, calls } = loadRelease();
  settle(mod, true);
  mod.state.inputIsActive = true;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("H1 dropping releases the relay again", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);
  heardEverything(mod);
  mod.state.inputIsActive = false;

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false]);
});

// ===== Rung 2: DHW demand =====

test("a DHW demand releases the boiler unconditionally", () => {
  // Demand is a request for heat the system may not have, and the boiler answers it.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  dhwClock(mod, true);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a DHW clock never heard from asks for nothing", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  lock(mod, true);

  mod.checkSystemState();

  assert.strictEqual(mod.state.dhwDemandReceived, false);
  assert.deepStrictEqual(switchCommands(calls), []);
});

// ===== Rung 3: the power system =====
// VE.Bus and the lock are two readings of one condition, so they answer together, and VE.Bus
// is read first because .209 opens the lock *because* VE.Bus left Inverting.

test("the inverter off-grid abnormal releases the boiler after thirty minutes", () => {
  // Thirty minutes clears the fortnightly generator test run — 20 minutes minimum runtime —
  // without knowing anything about generators at all.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  dhwClock(mod, false);
  boiler(mod, false);

  vebusShortFor(mod, PASSTHRU, 29 * MINUTES);
  lock(mod, false); // .209 has opened the lock for the same reason, as it always will
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [], "lit the boiler for a generator test run");

  mod.state.vebusShortSince = Date.now() - (31 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a generator start never reaches the rung below it", () => {
  // The whole point of reading VE.Bus first. .209 opens the lock a poll after the generator
  // starts, and an open lock on the rung below releases the boiler at once — so a lock read
  // ahead of VE.Bus would light the boiler for every 20-minute test run.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  dhwClock(mod, false);
  boiler(mod, false);

  victron(mod, "vebusState", BULK);
  lock(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the lock open while the inverter is inverting is the battery, and waits for nothing", () => {
  // Nothing but a low battery opens the lock while the inverter is still inverting
  // off-grid, and a battery at 30% is released by reaching 90%, not by the minute passing.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);

  lock(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a generator run that ends into a battery shortage releases at once", () => {
  // The rung is re-read every poll, so when VE.Bus returns to Inverting with the lock still
  // open, what is left can only be the battery.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  dhwClock(mod, false);
  boiler(mod, false);
  vebusShortFor(mod, PASSTHRU, 5 * MINUTES);
  lock(mod, false);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [], "released inside the thirty minutes");

  victron(mod, "vebusState", INVERTING);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a lock never heard from releases nothing", () => {
  // The floor: an undeployed or unreachable .209 leaves .164 with H1 in hardware, which is
  // what it had before the Shelly was there.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  pastStartupGrace(mod);

  mod.checkSystemState();

  assert.strictEqual(mod.state.lockKnown, false);
  assert.deepStrictEqual(switchCommands(calls), []);
});

test("an unreadable power system asks for nothing", () => {
  // The Fröling's augers, fan and pump all run off the house supply, so releasing the boiler
  // because the power system cannot be read risks lighting a fire and then losing
  // circulation. The Cerbo is also what connects the BMS to the inverter, so a Cerbo this
  // controller cannot hear is a power system in trouble, not one it is merely unsure about.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  lock(mod, false);
  dhwClock(mod, false);
  boiler(mod, false);
  pastStartupGrace(mod);

  assert.strictEqual(mod.state.vebusReceived, false);
  assert.strictEqual(mod.shortageRelease(), "",
    "an open lock spoke for a power system this controller cannot read");
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "lit a fire on a power system nobody can read");
});

test("a stale reading asks for nothing either", () => {
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  lock(mod, false);
  pastStartupGrace(mod);

  mod.resetMqttData(); // the broker goes away, taking the readings with it
  assert.strictEqual(mod.shortageRelease(), "");
  mod.checkSystemState();

  assert.strictEqual(mod.state.vebusStale, true);
  assert.strictEqual(mod.state.vebusState, INVERTING, "the last reading was thrown away");
  assert.deepStrictEqual(switchCommands(calls), []);
});

test("the wait survives a broker blip rather than starting over", () => {
  // The readings either side of a blip both say the inverter is off-grid abnormal, so the
  // run of them is unbroken. Restarting the thirty minutes on every blip is how a shortage
  // never becomes sustained.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  vebusShortFor(mod, PASSTHRU, 29 * MINUTES);
  const since = mod.state.vebusShortSince;

  mod.resetMqttData();
  victron(mod, "vebusState", PASSTHRU); // the broker returns, saying the same thing
  dhwClock(mod, false);
  boiler(mod, false);

  assert.strictEqual(mod.state.vebusShortSince, since);
  mod.state.vebusShortSince = Date.now() - (31 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the inverter recovering clears the wait", () => {
  const { mod } = loadRelease();
  vebusShortFor(mod, PASSTHRU, 29 * MINUTES);

  victron(mod, "vebusState", INVERTING);

  assert.strictEqual(mod.state.vebusShortSince, 0,
    "the next generator run would inherit the last one's twenty-nine minutes");
});

// ===== Rung 3, and a relay that is already on =====

test("a relay already on keeps the release rather than re-timing it", () => {
  // A script that has just restarted cannot measure what it did not watch: .209 publishes
  // the lock, and the Cerbo the inverter state, but neither says when it changed. The relay
  // does — it is on, so whatever released it had already waited.
  const { mod, calls } = loadRelease();
  settle(mod, true);
  pastStartupGrace(mod);
  dhwClock(mod, false);
  boiler(mod, false);

  victron(mod, "vebusState", PASSTHRU); // ten seconds old, as far as this run knows
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "a redeploy mid-burn dropped the release and started the thirty minutes again");
});

test("a relay H1 alone was holding closed does not become a shortage release", () => {
  // `follow` opens the relay on the H1 edge, so the "already on" clause finds nothing to
  // continue — which is what stops a two-minute-old generator run inheriting a release H1
  // had been holding.
  const { mod, calls } = loadRelease();
  settle(mod, true);
  mod.state.inputIsActive = true;
  pastStartupGrace(mod);
  dhwClock(mod, false);
  boiler(mod, false);
  vebusShortFor(mod, PASSTHRU, 2 * MINUTES);

  mod.state.inputIsActive = false; // H1 drops, and the hardware opens the relay with it
  settle(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

// ===== Rung 4: the exercise run =====
// Fourteen days with no observed ignition releases the boiler, held for one hour after it
// lights. The point is that every moving part gets the opportunity to move, in exactly the
// damp idle conditions that tar up an auger.

test("fourteen days with no ignition releases the boiler", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (14 * DAYS);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("thirteen days does not", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (13 * DAYS);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a clock the device has never synchronised runs no exercise", () => {
  // A timestamp written before NTP landed reads as decades once it does, which would light
  // the boiler on the first poll after a redeploy. So the rung asks whether the clock has
  // ever been set, not whether it reads plausibly.
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockUnsynchronised(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("no exercise runs while the boiler state is unavailable", () => {
  // The boiler input is what completes an exercise run — it is how this controller learns
  // the boiler lit, and so when to stop asking — and it comes from the Cerbo like
  // everything else. No boiler input, no exercise run.
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockAt(now);
  victron(mod, "vebusState", INVERTING);
  lock(mod, true);
  dhwClock(mod, false);
  mod.state.lastIgnition = now - (20 * DAYS);

  assert.strictEqual(mod.state.boilerReceived, false);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("an exercise run is held for an hour after ignition, then dropped", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true], "the exercise never started");

  settle(mod, true);
  boiler(mod, true); // it lights
  assert.strictEqual(mod.state.lastIgnition, now, "the ignition was not observed");

  clockAt(now + 59 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "dropped the release before the burn had done anything");

  clockAt(now + 61 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true, false]);
});

test("an exercise run that has finished does not start again", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, true);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);
  mod.checkSystemState();
  boiler(mod, true);

  clockAt(now + 2 * HOURS);
  mod.checkSystemState();
  settle(mod, false);
  clockAt(now + 3 * HOURS);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false],
    "the hold expired into another fourteen-day release");
});

test("an ordinary burn resets the fourteen days without releasing anything", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (2 * DAYS);

  boiler(mod, true); // H1, or the heating side, lit it
  mod.checkSystemState();

  assert.strictEqual(mod.state.lastIgnition, now);
  assert.deepStrictEqual(switchCommands(calls), [],
    "an ignition nothing asked for asserted a release of its own");
});

test("an observed ignition is written down, because RAM does not survive a reboot", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  clockAt(now);
  boiler(mod, false);
  mod.state.lastIgnition = now - (2 * DAYS);

  boiler(mod, true);

  const writes = calls.filter((c) => c.method === "KVS.Set");
  assert.strictEqual(writes.length, 1, "the ignition was recorded in RAM only");
  assert.strictEqual(writes[0].params.key, mod.config.kvs.lastIgnition);
  assert.strictEqual(writes[0].params.value, now);
});

test("re-ignition within the hold is not written down again", () => {
  // The boiler cycles several times a day while it is lit, and the value is only ever read
  // against fourteen days.
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  clockAt(now);
  boiler(mod, false);
  mod.state.lastIgnition = now - (10 * MINUTES);

  boiler(mod, true);

  assert.deepStrictEqual(calls.filter((c) => c.method === "KVS.Set"), []);
  assert.strictEqual(mod.state.lastIgnition, now - (10 * MINUTES),
    "a cycling boiler rewrote flash on every ignition");
});

test("the first ever run seeds the ignition time, so a redeploy never lights the boiler", () => {
  const now = 1788374651000;
  const { mod, calls } = loadRelease();
  clockAt(now);

  mod.readLastIgnition();
  const get = calls.filter((c) => c.method === "KVS.Get").pop();
  assert.strictEqual(get.params.key, mod.config.kvs.lastIgnition);

  get.cb(null, -105, "No such key"); // never written: this is the first run

  assert.strictEqual(mod.state.lastIgnition, now);
  const writes = calls.filter((c) => c.method === "KVS.Set");
  assert.strictEqual(writes.length, 1, "the seed was not persisted");
  assert.strictEqual(writes[0].params.value, now);
});

test("a recorded ignition time survives the redeploy that reads it", () => {
  const now = 1788374651000;
  const stored = now - (3 * DAYS);
  const { mod, calls } = loadRelease();
  clockAt(now);

  mod.readLastIgnition();
  calls.filter((c) => c.method === "KVS.Get").pop().cb({ value: stored }, 0, null);

  assert.strictEqual(mod.state.lastIgnition, stored);
  assert.deepStrictEqual(calls.filter((c) => c.method === "KVS.Set"), [],
    "reading the value back rewrote it, which resets the fourteen days on every deploy");
});

test("nothing is seeded or read without a clock to write down", () => {
  const { mod, calls } = loadRelease();
  clockUnsynchronised(1788374651000);

  mod.readLastIgnition();

  assert.deepStrictEqual(calls.filter((c) => c.method === "KVS.Get"), []);
  assert.deepStrictEqual(calls.filter((c) => c.method === "KVS.Set"), []);
  assert.strictEqual(mod.state.lastIgnition, null);
});

// ===== The order of the ladder =====

test("H1 answers before anything else is consulted", () => {
  const { mod } = loadRelease();
  settle(mod, false);
  mod.state.inputIsActive = true;
  dhwClock(mod, true);
  vebusShortFor(mod, PASSTHRU, 31 * MINUTES);

  assert.strictEqual(mod.releaseReason(), "H1");
});

test("the exercise run is last, because it is the weakest", () => {
  // Satisfied by an ignition from any cause at any time, and in no hurry: anything else
  // asking has already released the boiler, which is all the exercise wanted.
  const now = 1788374651000;
  const { mod } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);
  dhwClock(mod, true);

  assert.strictEqual(mod.releaseReason(), "DHW demand");
});

test("the exercise run is still reached when the power system is quiet", () => {
  // Rung 3 answering "no" must not stop the ladder: VE.Bus masks the lock, not everything
  // below it.
  const now = 1788374651000;
  const { mod } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);

  assert.strictEqual(mod.releaseReason(), "exercise run");
});

test("a shortage explains the release before the exercise run does", () => {
  // Both can be true at once, and the relay has one position: the reason reported should be
  // the one that would still be asking tomorrow.
  const now = 1788374651000;
  const { mod } = loadRelease();
  settle(mod, false);
  clockAt(now);
  heardEverything(mod);
  mod.state.lastIgnition = now - (20 * DAYS);
  vebusShortFor(mod, PASSTHRU, 31 * MINUTES);

  assert.ok(mod.releaseReason().indexOf("shortage") === 0, mod.releaseReason());
});

// ===== The minimum on time =====

test("a release this script granted stands for an hour", () => {
  // By then the boiler may have begun an ignition cycle, which is the expensive part.
  const { mod, calls } = loadRelease();
  settle(mod, false);
  heardEverything(mod);
  dhwClock(mod, true);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
  mod.state.relayIsOn = true;
  assert.ok(mod.state.releasedAt > 0,
    "the release did not write down when it was granted, so nothing holds it");

  dhwClock(mod, false); // the clock stops calling five minutes later
  mod.state.releasedAt = Date.now() - (5 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true], "dropped a burn five minutes in");

  mod.state.releasedAt = Date.now() - (61 * MINUTES);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true, false]);
});

test("it says nothing about a relay this script merely found closed", () => {
  // That one belongs to whatever closed it — H1, or a previous run — and the ladder decides
  // it on the readings, not on a clock this run never started.
  const { mod, calls } = loadRelease();
  settle(mod, true);
  heardEverything(mod);

  mod.checkSystemState();

  assert.strictEqual(mod.state.releasedAt, 0);
  assert.deepStrictEqual(switchCommands(calls), [false]);
});

// ===== A restart, with the boiler already burning =====

test("a redeploy does not drop a release before the readings arrive", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);

  assert.notStrictEqual(mod.outstandingReadings(), "");
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "every redeploy would interrupt a burn in progress");
});

test("past the grace, silence is taken at face value", () => {
  const { mod, calls } = loadRelease();
  settle(mod, true);
  pastStartupGrace(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false],
    "a release nothing can justify was held indefinitely");
});

test("the readings it waits for are the ones that could justify a release", () => {
  const { mod } = loadRelease();

  assert.ok(mod.outstandingReadings().indexOf("the heat pump lock") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the DHW time clock") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the boiler state") >= 0);
  assert.ok(mod.outstandingReadings().indexOf("the inverter state") >= 0);

  heardEverything(mod);
  assert.strictEqual(mod.outstandingReadings(), "");
});

// ===== What it says it is doing =====

test("the status line names the relay and which way its contact is", () => {
  const { mod } = loadRelease();
  settle(mod, false);

  assert.ok(statusText(mod).indexOf("Boiler Release OFF") >= 0, statusText(mod));
});

test("it claims no reading it has not been given", () => {
  // Every one of these is silent between transitions, so a fresh start has none of them.
  const { mod } = loadRelease();
  const text = statusText(mod);

  assert.ok(text.indexOf("HP ?") >= 0, "invented a lock position: " + text);
  assert.ok(text.indexOf("VE ?") >= 0, "invented a VE.Bus state: " + text);
  assert.ok(text.indexOf("Boiler ?") >= 0, "invented a boiler state: " + text);
  assert.ok(text.indexOf("DHW ?") >= 0, "invented a time clock position: " + text);
});

test("the status line shows how long the inverter has been off-grid abnormal", () => {
  // The one duration that decides anything, so the one worth showing — and in a unit that
  // says something: rounded down to whole minutes, the first one reads "0m".
  const { mod } = loadRelease();
  settle(mod, false);
  victron(mod, "vebusState", PASSTHRU);

  assert.ok(statusText(mod).indexOf("VE Passthru 0s") >= 0, statusText(mod));

  mod.state.vebusShortSince = Date.now() - (31 * MINUTES);
  assert.ok(statusText(mod).indexOf("VE Passthru 31m") >= 0, statusText(mod));
});

test("a stale reading is shown as stale rather than as an invented Off", () => {
  const { mod } = loadRelease();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);

  mod.resetMqttData();

  assert.ok(statusText(mod).indexOf("VE Inverting (stale)") >= 0, statusText(mod));
});

test("the status line says which rung released the boiler", () => {
  const { mod } = loadRelease();
  settle(mod, true);
  mod.state.inputIsActive = true;
  dhwClock(mod, true);

  assert.ok(statusText(mod).indexOf("Released: H1") >= 0,
    "a released boiler that does not say what asked for it: " + statusText(mod));
});

test("the banner states the numbers that decide when wood burns", () => {
  const { mod } = loadRelease();

  const banner = bannerText(mod);

  assert.ok(banner.indexOf("30 minutes") >= 0, banner);
  assert.ok(banner.indexOf("60 minutes") >= 0, banner);
  assert.ok(banner.indexOf("14 days") >= 0, banner);
});

// ===== The plumbing under all of it =====

test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadRelease();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  // Connected is the ordinary case: the device's MQTT client is up long before the script
  // starts, so a check that only ran when offline would never run at all.
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
  const { mod, calls } = loadRelease();
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
  const { mod, handlers } = loadRelease();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: true };
  };

  mod.connectMqtt();

  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");
});

test("keepalives keep asking for a republish until both silent readings arrive", () => {
  // vebus/276/State changes when a generator runs, months apart, and the boiler input when
  // the boiler starts or stops firing. Neither has anything to publish in between, so both
  // are only ever seen in a republish burst — and both are rungs of this ladder.
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();

  const keepalive = timers.filter((t) => t.repeat === true).pop();
  assert.ok(keepalive, "no periodic keepalive was scheduled");

  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "",
    "an empty payload is what asks the broker to republish everything");

  victron(mod, "vebusState", INVERTING);
  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "", "the boiler state had still not arrived");

  boiler(mod, false);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0,
    "once seen, stop asking the whole system to republish every 30 seconds");
});

test("the first republish request waits for the subscriptions to land", () => {
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();

  assert.deepStrictEqual(published, [],
    "a keepalive sent in the same breath as the subscriptions loses the burst it asks for");

  const delayed = timers.filter((t) => t.repeat === false).pop();
  assert.strictEqual(delayed.ms, mod.config.initialKeepaliveDelay);

  delayed.fn();
  assert.strictEqual(published[0].payload, "");
});

// Shelly publishes status on change and does not retain it. A relay's input has no
// telemetry to drift, so it says nothing until someone moves it — and a time clock can sit
// still for hours. So a follower asks rather than assumes.
function statusUpdates(published, commandTopic) {
  return published.filter((p) => p.topic === commandTopic && p.payload === "status_update");
}

test("both followed devices are asked to republish, once the subscriptions are in", () => {
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();

  assert.deepStrictEqual(published, [],
    "a request sent in the same breath as the subscription loses the answer it asks for");

  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic).length, 1);
  assert.strictEqual(statusUpdates(published, mod.config.dhwClock.commandTopic).length, 1);
});

test("it keeps asking until each of them answers", () => {
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();
  const periodic = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  periodic.fn();
  assert.strictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic).length, 1,
    "one lost request would leave it blind until .209 next changed its mind");

  lock(mod, true);
  published.length = 0;
  periodic.fn();
  assert.deepStrictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic), []);
  assert.strictEqual(statusUpdates(published, mod.config.dhwClock.commandTopic).length, 1,
    "the time clock had still not answered");
});

test("a reconnect asks both of them again", () => {
  // Not just a gap in the data: either may have moved while this controller was away, and
  // neither will say so again until it next moves.
  const { mod, published, timers } = loadRelease();
  mod.handleMqttConnected();
  lock(mod, true);
  dhwClock(mod, true);

  mod.resetMqttData();
  published.length = 0;
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published, mod.config.heatPumpLock.commandTopic).length, 1);
  assert.strictEqual(statusUpdates(published, mod.config.dhwClock.commandTopic).length, 1);
});

test("a broker drop forgets the time clock and keeps the lock", () => {
  // A time clock may have moved while the broker was away. Silence from .209 is not .209
  // saying the battery recovered.
  const { mod } = loadRelease();
  heardEverything(mod);
  lock(mod, false);
  dhwClock(mod, true);

  mod.resetMqttData();

  assert.strictEqual(mod.state.dhwDemand, false);
  assert.strictEqual(mod.state.dhwDemandReceived, false);
  assert.strictEqual(mod.state.lockKnown, true);
  assert.strictEqual(mod.state.lockIsClosed, false);
});
