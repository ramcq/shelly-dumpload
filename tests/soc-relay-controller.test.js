// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Tests for both roles: DHW immersion (dump load) and Heat Pump Enable (.209,
// shortage lead). Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog, advanceClock, withJumpedWallClock } = require("./harness.js");

const DUMP = "soc-relay-controller.js";

const HEAT_PUMP_ENABLE = "shelly1minig3-d885ac0a3668"; // .209, no band of its own
const LEAD_RELAY = "shelly1pmg3-543204558fc8"; // .90, Left Bottom, 94/93, time switch
const LEFT_TOP = "shelly1pmg3-543204558c6c"; // .88, 96/95, a plain follower
const RIGHT = "shelly1pmg3-dcda0ce04fb0"; // .91, 95/94
const ANNEX = "shelly1pmg3-dcda0ce06e98"; // .100, 96/95, the last tank in the poll window
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0";
const PORTAL = "c0847dc9a794";

const INVERTING = 9;
const PASSTHRU = 8;

const MINUTES = 60 * 1000;

// Load the script as one relay from the table
function loadRelay(deviceId) {
  const loaded = load(DUMP, deviceId);
  assert.strictEqual(loaded.mod.state.identityKnown, true,
    deviceId + " resolved no role from the relay table");
  return loaded;
}

// A plain follower: not the lead relay or the shortage lead
function loadImmersion() {
  return loadRelay(LEFT_TOP);
}

function loadShortageLead() {
  return loadRelay(HEAT_PUMP_ENABLE);
}

function victron(mod, key, value) {
  mod.processMqttMessage(
    "N/" + PORTAL + "/" + mod.config.topics[key],
    JSON.stringify({ value: value }));
}

// .209's switch status: closed = heat pump running, open = shortage
function lock(mod, closed) {
  mod.processMqttMessage(HP_LOCK, JSON.stringify({ id: 0, output: closed }));
}

// The lead relay's input status (manual time switch)
function leadInput(mod, active) {
  mod.processMqttMessage(mod.config.leadRelay.inputTopic, JSON.stringify({ state: active }));
}

// Set a known baseline state
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
}

// The last Switch.Set command, if any (the harness never runs Shelly.call callbacks)
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

// ===== Role resolution =====

test("identity is resolved before anything else runs", () => {
  const { mod, calls } = loadImmersion();

  assert.strictEqual(mod.state.deviceName, "DHW Left Top",
    "the role is not resolved by the time the script is running");
  assert.strictEqual(calls[0].method, "Shelly.GetComponents",
    "startup does something before it knows which device it is on");
});

test("a device the table does not list resolves no role and runs nothing", () => {
  const { mod, calls, timers } = load(DUMP, "shelly1pmg3-000000000000");

  assert.strictEqual(mod.state.identityKnown, false);
  assert.deepStrictEqual(calls, [], "a device with no role created components");
  assert.deepStrictEqual(timers, [], "a device with no role scheduled work");
});

test("a DHW immersion is not the shortage lead", () => {
  const { mod } = loadRelay(LEAD_RELAY);
  assert.strictEqual(mod.state.isShortageLead, false);
  assert.strictEqual(mod.state.isLeadRelay, true, "the table did not name the lead relay");
});

test("the table carries the stagger the immersions exist to have", () => {
  const expected = { "543204558c6c": 96, "543204558fc8": 94, "dcda0ce04fb0": 95,
                     "dcda0ce06e98": 96 };
  Object.keys(expected).forEach((id) => {
    const { mod } = loadRelay(id);
    assert.strictEqual(mod.state.highSocThreshold, expected[id], id);
    assert.strictEqual(mod.state.lowSocThreshold, expected[id] - 1,
      "an immersion derives its low threshold rather than pinning one");
  });
});

test("the shortage lead has no SOC band of its own", () => {
  const { mod } = loadShortageLead();
  assert.strictEqual(mod.state.highSocThreshold, 0,
    "its relay is the shortage terms, not a dump load band");
  assert.strictEqual(mod.config.shortage.lowSoc, 30);
  assert.strictEqual(mod.config.shortage.highSoc, 90);
});

test("a device not in the table runs nothing", () => {
  const { mod } = load(DUMP);
  assert.strictEqual(mod.applySettingsForDevice("shelly1pmg3-000000000000"), false);
  assert.strictEqual(mod.state.identityKnown, false,
    "a misdirected deploy must leave the relay in its unscripted behaviour");
});

test("no dwell timers in either role", () => {
  ["minOnTime", "minOffTime"].forEach((knob) => {
    assert.strictEqual(loadImmersion().mod.config[knob], undefined, knob);
    assert.strictEqual(loadShortageLead().mod.config[knob], undefined, knob);
  });
});

test("no relay gets a threshold slider", () => {
  const { mod, calls } = loadShortageLead();
  mod.setupVirtualComponents([]);

  const added = calls.filter((c) => c.method === "Virtual.Add");
  assert.deepStrictEqual(added.map((c) => c.params.type), ["text"],
    "the thresholds must live in the table, not in components on five devices");
  assert.strictEqual(added[0].params.config.name, "Status");
});

test("a threshold component left behind on a device is not read", () => {
  // number:202 may be left over from an earlier script
  const { mod } = loadImmersion();
  global.Virtual.getHandle = function () {
    return { getValue: function () { return 50; }, on: function () {} };
  };

  mod.finishSetup();

  assert.strictEqual(mod.state.highSocThreshold, 96,
    "a stale persisted slider moved this immersion off its place in the stagger");
  assert.strictEqual(mod.state.lowSocThreshold, 95);
});

// ===== What shortage is =====

// See CONTROLS.md#shortage

test("at or below 30 the system is short whatever is generating", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 8000);
  victron(mod, "batterySOC", 30);

  assert.strictEqual(mod.inShortage(), true,
    "ten points above the generator autostart, generation is no longer the question");
});

test("recovering past 30 does not release the lock", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 1500); // generating, but less than the heat pump draws
  victron(mod, "batterySOC", 31);
  mod.checkSystemState();

  victron(mod, "batterySOC", 30);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false], "30% did not lock the heat pump");
  settle(mod, false); // the relay opened; the harness never runs the callback that says so

  victron(mod, "batterySOC", 31);
  mod.checkSystemState();
  victron(mod, "batterySOC", 35);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false],
    "the lock released as soon as the shed load let the battery gain a point");
});

test("the lock is held until 90, not until generation returns", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 25);
  mod.checkSystemState();
  settle(mod, false);

  victron(mod, "acGeneration", 8000);
  victron(mod, "batterySOC", 89);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false], "89% is not 90%");

  victron(mod, "batterySOC", 90);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false, true]);
});

test("a controller starting mid-band assumes shortage", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 60);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false],
    "a redeploy at 60% with nothing generating must not assume the battery is on its way up");
});

test("generation resolves a mid-band start the other way", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true); // the heat pump was running when the script restarted
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 60);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "something is coming in, so the heat pump keeps running through a redeploy");
  assert.strictEqual(mod.inShortage(), false);
});

test("generation does not release a lock that was resolved by the thresholds", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 29);
  mod.checkSystemState();

  victron(mod, "acGeneration", 8000);
  victron(mod, "batterySOC", 50);
  mod.checkSystemState();

  assert.strictEqual(mod.inShortage(), true,
    "generation only settles a latch that was never resolved, not one 30% set");
});

test("a generator run that clears mid-band returns to the latch, not to 90", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 95);
  mod.checkSystemState();

  victron(mod, "vebusState", PASSTHRU); // the generator starts
  victron(mod, "batterySOC", 60);
  mod.checkSystemState();
  assert.strictEqual(mod.inShortage(), true);

  victron(mod, "vebusState", INVERTING); // and stops
  mod.checkSystemState();
  assert.strictEqual(mod.inShortage(), false,
    "a passthrough that clears must not leave the heat pump locked until 90%");
});

test("the SOC terms settle the latch before any VE.Bus reading arrives", () => {
  const { mod } = loadShortageLead();
  victron(mod, "batterySOC", 25);

  assert.strictEqual(mod.state.shortageLatch, true,
    "the VE.Bus term gated the latch instead of overlaying it");
});

test("at or above 90 it is not, whatever is generating", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 90); // night: no generation at all

  assert.strictEqual(mod.inShortage(), false,
    "a full battery at night is not a shortage");
});

test("between the two, generation settles a controller that has just started", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);
  assert.strictEqual(mod.inShortage(), true,
    "nothing seen coming in yet, and no way to know which way the battery was going");

  victron(mod, "acGeneration", 3000);
  assert.strictEqual(mod.inShortage(), false, "half a battery and hydro is recovering");

  victron(mod, "acGeneration", 0);
  assert.strictEqual(mod.inShortage(), false,
    "generation settles the question once; after that only the thresholds move it, so " +
    "losing the hydro at 50% runs the battery down to 30 rather than shedding on the spot");
});

test("an idle turbine reporting its own draw is not generation", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);
  victron(mod, "dcGeneration", -40);

  assert.strictEqual(mod.inShortage(), true);
});

test("an immersion does not work shortage out for itself", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "an immersion that reasons about the battery is one more copy of the power system");
});

// ===== Entering shortage =====

test("SOC below 30 locks the heat pump immediately", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 29);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("anything other than inverting locks the heat pump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "batterySOC", 95);
  victron(mod, "vebusState", PASSTHRU);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("a lost broker counts as not inverting", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "batterySOC", 95);
  victron(mod, "vebusState", INVERTING);
  mod.resetMqttData();

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false],
    "an unknown VE.Bus state must lock the heat pump, not leave it running");
});

// ===== Leaving shortage =====

test("SOC recovering to 90 unlocks the heat pump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 90);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a partial recovery leaves the heat pump locked", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 89);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "89% is what a generator run can reach; only hydro or solar passes 90");
});

test("the heat pump does not wait for generation", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 0);
  victron(mod, "dcGeneration", 0);
  victron(mod, "batterySOC", 95);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "the heat pump is a load, not a dump: it is not gated on generation");
});

test("a negative generation reading does not hold the heat pump locked", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "dcGeneration", -40); // an idle turbine reporting its own draw
  victron(mod, "batterySOC", 95);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("inverter overload does not lock the heat pump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 95);
  victron(mod, "inverterOutput", 14000);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "overload reaches the heat pump through the VE.Bus term once the generator starts");
});

test("a loaded inverter does not block unlocking the heat pump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 95);
  victron(mod, "inverterOutput", 11000); // no headroom for an immersion

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "no constant for the heat pump's draw would be real, so no headroom check");
});

// ===== The time switch reaches the immersions, not the heat pump =====

test("the manual time switch cannot unlock the heat pump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 20);
  mod.state.inputIsActive = true;
  mod.state.leadInputActive = true;

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "a request for hot water is not a reason to run the heat pump on a flat battery");
});

test("the shortage lead subscribes to no time-switch topic", () => {
  // Control case: an immersion does subscribe
  const immersion = loadImmersion();
  immersion.mod.handleMqttConnected();
  assert.ok(
    immersion.subscribed.some((t) => t === immersion.mod.config.leadRelay.inputTopic),
    "an immersion must follow the manual time switch");

  const heatPump = loadShortageLead();
  heatPump.mod.handleMqttConnected();
  assert.strictEqual(heatPump.mod.state.leadRelayTopic, "");
  assert.ok(heatPump.subscribed.length > 0, "nothing was subscribed at all");
  heatPump.subscribed.forEach((topic) => {
    assert.ok(topic.indexOf("/status/input:") < 0,
      "the shortage lead followed a time switch: " + topic);
  });
});

test("stays within Shelly's ten-subscription cap in both roles", () => {
  const immersion = loadImmersion();
  immersion.mod.handleMqttConnected();
  assert.ok(immersion.subscribed.length > 6,
    "the immersion's lead relay and heat pump lock topics were not both counted");
  assert.ok(immersion.subscribed.length <= 10,
    "immersion holds " + immersion.subscribed.length + " subscriptions");

  const heatPump = loadShortageLead();
  heatPump.mod.handleMqttConnected();
  assert.ok(heatPump.subscribed.length <= 10,
    "shortage lead holds " + heatPump.subscribed.length + " subscriptions");
});

// ===== The immersions keep every gate the heat pump drops =====

test("an immersion still waits for generation", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 0);
  victron(mod, "dcGeneration", 0);
  victron(mod, "batterySOC", 99);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "a full battery at night must not start a dump");
});

test("an immersion still sheds on inverter overload", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 99);
  victron(mod, "inverterOutput", 14000);

  assert.deepStrictEqual(switchCommands(calls), [false],
    "the fast path did not shed on the MQTT message");
});

test("an immersion still checks inverter headroom before enabling", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 99);
  victron(mod, "inverterOutput", 11000); // 11 kW + 2.7 kW is over the 13 kW limit

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), []);
});

// The fast path only sheds a relay known to be on; the poll covers the rest

test("the poll sheds an overload the fast path was in no position to see", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 99);
  victron(mod, "inverterOutput", 14000); // arrives with the relay open: nothing to shed

  assert.deepStrictEqual(switchCommands(calls), []);

  settle(mod, true); // closed since, by the lead relay's follow rather than by this script
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("a standing overload blocks the time switch, which nothing below it does", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 5000);
  victron(mod, "batterySOC", 99);
  victron(mod, "inverterOutput", 14000);
  mod.state.inputIsActive = true;   // the strongest enable this relay has

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "hot water on demand still does not mean 2.7 kW onto an inverter already over");
});

test("an immersion sheds the moment SOC falls", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 94);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false],
    "a hydro trip must not wait out a dwell before 2.7 kW comes off the inverter");
});

test("the manual time switch turns an immersion on well below its SOC threshold", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 50); // well below its 96% threshold

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "someone asking for hot water is not second-guessed against a battery that is filling");
});

// ===== Following the heat pump lock =====

// See CONTROLS.md#who-decides-and-how-the-decision-travels

test("an immersion follows the lock, and .209 follows nothing", () => {
  const immersion = loadImmersion();
  immersion.mod.handleMqttConnected();
  assert.ok(immersion.subscribed.some((t) => t === HP_LOCK),
    "an immersion cannot shed on a shortage it never hears about");

  const heatPump = loadShortageLead();
  heatPump.mod.handleMqttConnected();
  assert.strictEqual(heatPump.mod.state.lockTopic, "");
  heatPump.subscribed.forEach((topic) => {
    assert.ok(topic.indexOf("/status/switch:") < 0,
      "the shortage lead subscribed to its own decision: " + topic);
  });
});

test("an open lock sheds the immersion, time switch and all", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, true); // the time switch has it on
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, false);

  assert.deepStrictEqual(switchCommands(calls), [false],
    "2.7 kW of hot water is not something to make on a flat battery, and shedding is the " +
    "safety direction: it happens on the edge, without waiting for a poll");
});

test("the time switch does not run an immersion off the generator", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, true);
  mod.state.leadInputActive = true;
  victron(mod, "batterySOC", 99);
  victron(mod, "vebusState", PASSTHRU); // .209 opens the lock on the VE.Bus term

  lock(mod, false);

  assert.deepStrictEqual(switchCommands(calls), [false],
    "the floor has to hold against a deliberately set time switch, or it is not a floor");
});

test("the lead relay's hardware follow is turned back off", () => {
  // .90 is in_mode follow; Switch.Set overrides follow until the next input edge
  const { mod, calls } = loadRelay(LEAD_RELAY);
  settle(mod, true);
  mod.state.inputIsActive = true;
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, false);

  assert.deepStrictEqual(switchCommands(calls), [false],
    "the floor has to reach the relay the time switch is wired to, not just its followers");
});

test("a lock never heard from sheds nothing", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  assert.strictEqual(mod.state.lockKnown, false);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "a .209 not yet deployed, or not answering, must not silently disable the time switch");
});

test("an immersion keeps its own VE.Bus gate when no lock answers", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, true);
  victron(mod, "batterySOC", 99);
  victron(mod, "acGeneration", 3000);
  victron(mod, "vebusState", PASSTHRU); // the generator is running

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false],
    "a dump load must be safe with nothing published by .209 at all");
});

// Right tank: 10 s offset
function loadRight() {
  return loadRelay(RIGHT);
}

function waitedOffset(mod, timers) {
  const t = timers.filter((x) => x.repeat === false).pop();
  advanceClock(t.ms);
  t.fn();
}

test("closing the lock enables after this relay's offset", () => {
  const { mod, calls, timers } = loadRight();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, false);
  lock(mod, true);
  mod.checkSystemState(); // a poll landing inside the offset
  assert.deepStrictEqual(switchCommands(calls), []);

  waitedOffset(mod, timers);
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the left tank enables on the edge", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, false);
  lock(mod, true);

  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("a lock that reopens within the offset is just a shed", () => {
  const { mod, calls, timers } = loadRight();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, true);
  lock(mod, false);
  waitedOffset(mod, timers);

  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a lost broker does not close the lock", () => {
  const { mod, calls } = loadImmersion();
  lock(mod, false);
  mod.resetMqttData();

  assert.strictEqual(mod.state.lockKnown, true,
    "silence is not .209 saying the battery recovered");
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "a broker drop handed the timer back at the moment least able to afford it");
});

test("an immersion asks the lock to republish, and keeps asking until it answers", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();
  const periodic = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  periodic.fn();
  assert.strictEqual(
    published.filter((pub) => pub.topic === mod.config.heatPumpLock.commandTopic &&
                              pub.payload === "status_update").length, 1,
    "the immersion assumed the heat pump was running instead of asking");

  lock(mod, true);
  published.length = 0;
  periodic.fn();
  assert.deepStrictEqual(
    published.filter((pub) => pub.topic === mod.config.heatPumpLock.commandTopic), [],
    "once answered, stop asking .209 to republish everything every 30 seconds");
});

test("a reconnect asks both followed devices again", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();
  mod.processMqttMessage(mod.state.leadRelayTopic, '{"id":0,"state":true}');
  lock(mod, true);

  published.length = 0;
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  const asked = published.filter((pub) => pub.payload === "status_update").map((pub) => pub.topic);
  assert.deepStrictEqual(asked.sort(),
    [mod.config.leadRelay.commandTopic, mod.config.heatPumpLock.commandTopic].sort());
});

test("the shortage lead asks nobody anything", () => {
  const { mod, published, timers } = loadShortageLead();
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.deepStrictEqual(published.filter((pub) => pub.payload === "status_update"), []);
});

// ===== Spacing the release out =====

test("the time switch turning on enables after this relay's offset", () => {
  const { mod, calls, timers } = loadRight();
  settle(mod, false);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);
  lock(mod, true);

  leadInput(mod, true);
  assert.deepStrictEqual(switchCommands(calls), []);

  waitedOffset(mod, timers);
  assert.deepStrictEqual(switchCommands(calls), [true]);
});

test("the time switch turning off still sheds on the edge", () => {
  const { mod, calls } = loadRight();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);
  lock(mod, true);
  leadInput(mod, true);

  leadInput(mod, false);

  assert.deepStrictEqual(switchCommands(calls), [false],
    "a relay held on by the clock alone must come off when the clock opens");
});

test("the poll offsets separate the tanks, not the devices", () => {
  // Left top and bottom share a slot. See CONTROLS.md#dump-loads-together
  const expected = {
    "543204558c6c": 0,          // DHW Left Top
    "543204558fc8": 0,          // DHW Left Bottom
    "dcda0ce04fb0": 10 * 1000,  // DHW Right
    "dcda0ce06e98": 20 * 1000   // DHW Annex
  };

  Object.keys(expected).forEach((id) => {
    assert.strictEqual(loadRelay(id).mod.state.pollOffset, expected[id], id);
  });

  assert.strictEqual(loadShortageLead().mod.state.pollOffset, 0,
    "the shortage lead has no dump load to space out, and everything else waits on it");
});

// ===== What .209 says it is doing =====

test("the shortage lead claims no shortage it has not established", () => {
  // inShortage() returns null here, which must not read as no shortage
  const { mod } = loadShortageLead();
  settle(mod, true); // .209 boots closed, so the relay is not what is under test here

  const text = statusText(mod);

  assert.ok(text.indexOf("SHORTAGE") < 0, "claimed a shortage it has not established: " + text);
  assert.ok(text.indexOf("nothing heard from the Cerbo yet") >= 0,
    "an unresolved shortage read as no shortage: " + text);
});

test("an unresolved shortage says which reading is missing", () => {
  const { mod } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING); // the Cerbo has been heard; the battery has not

  const text = statusText(mod);

  assert.ok(text.indexOf("no SOC reading yet") >= 0,
    "reported silence from a Cerbo it had just heard from: " + text);
  assert.ok(text.indexOf("SHORTAGE") < 0, text);
});

test("a relay says its own name and which way its contact is", () => {
  assert.ok(statusText(loadImmersion().mod).indexOf("DHW Left Top OFF") >= 0,
    "an immersion did not name itself");
  assert.ok(statusText(loadShortageLead().mod).indexOf("HP Enable OFF") >= 0,
    "the shortage lead did not name itself");
});

test("the band on the shortage lead is the shortage terms", () => {
  const { mod } = loadShortageLead();

  assert.ok(statusText(mod).indexOf("[On:90%, Off:30%]") >= 0,
    "the shortage band is the one thing .209's band could be: " + statusText(mod));
});

test("the shortage lead reports no lead input it never receives", () => {
  const { mod } = loadShortageLead();
  settle(mod, true);

  const text = statusText(mod);

  assert.ok(text.indexOf("Lead ") < 0,
    "reported a time switch it hears nothing about: " + text);
});

test("an immersion still reports the lead input it follows", () => {
  const { mod } = loadImmersion();

  assert.ok(statusText(mod).indexOf("Lead OFF") >= 0,
    "a follower stopped reporting the time switch it acts on");
});

test("the lead relay reports its own input, not itself as a lead", () => {
  const { mod } = loadRelay(LEAD_RELAY);

  const text = statusText(mod);

  assert.ok(text.indexOf("Lead ") < 0, "the lead relay reported following itself: " + text);
  assert.ok(text.indexOf("Input OFF") >= 0, text);
});

test("the shortage lead's banner offers no dump load band", () => {
  const { mod } = loadShortageLead();

  const banner = bannerText(mod);

  assert.ok(banner.indexOf("SOC Threshold") < 0,
    "the banner offered a band .209 does not have: " + banner);
  assert.ok(banner.indexOf("Shortage band: 30% to 90%") >= 0, banner);
});

test("an immersion's banner still states its band", () => {
  const { mod } = loadImmersion();

  const banner = bannerText(mod);

  assert.ok(banner.indexOf("High SOC Threshold: 96%") >= 0, banner);
  assert.ok(banner.indexOf("Low SOC Threshold: 95%") >= 0, banner);
});

// ===== The decision has to leave the device =====

// Followers read .209's published switch status
test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadShortageLead();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  // Already connected, the usual case at script start
  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: false };
  };

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1, "the device was left publishing nothing");
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured or rebooted", () => {
  const { mod, calls } = loadShortageLead();
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

// ===== Manual intervention =====

test("a fresh start does not lock the heat pump before its first VE.Bus reading", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), []);
});

test("a broker that never answers locks the heat pump once the grace expires", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  advanceClock(mod.config.startupGrace + 1000);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false],
    "silence past the grace is the trouble the VE.Bus gate exists for");
});

test("the grace does not return once a reading has been seen", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  victron(mod, "vebusState", INVERTING);
  mod.resetMqttData(); // broker drops, taking the state with it

  assert.strictEqual(mod.state.vebusReceived, true,
    "a stale reading must not be mistaken for a controller that has just started");
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [false]);
});

test("a firmware without a status notification setting is not rebooted", () => {
  const { mod, calls } = loadShortageLead();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server }; // no status_ntf key at all
  };

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "an absent key would reboot the device on every script start, forever");
});

// ===== Which term locked the relay decides how it is released =====

test("no relay is commanded before the role is known", () => {
  const { mod, calls } = load(DUMP); // identity deliberately unresolved
  mod.state.relayIsOn = true;
  victron(mod, "vebusState", PASSTHRU);
  victron(mod, "batterySOC", 20);

  assert.strictEqual(mod.state.identityKnown, false);
  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [],
    "guessing the role would run .209 as an immersion: locked below 95%, shed on overload");
});

// ===== Losing the broker =====

test("a disconnect handler is installed even when MQTT is already connected", () => {
  const { mod, handlers } = loadShortageLead();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () {
    return { enable: true, server: server, status_ntf: true };
  };
  victron(mod, "vebusState", INVERTING);

  mod.connectMqtt();
  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");

  handlers.disconnect();
  assert.strictEqual(mod.state.vebusState, 0, "a lost broker must not leave a stale state");
  assert.strictEqual(mod.state.mqttConnected, false);
});

// ===== Seeding a value that almost never changes =====

// Victron publishes only on change, so VE.Bus state is seen only in a republish
test("keepalives keep requesting a republish until VE.Bus has been seen", () => {
  const { mod, published, timers } = loadImmersion();
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
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0,
    "once seen, stop asking the whole system to republish every 30 seconds");
});

test("keepalives ask for VE.Bus again after a broker drop", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();
  victron(mod, "vebusState", INVERTING);
  mod.resetMqttData();

  const keepalive = timers.filter((t) => t.repeat === true).pop();
  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "");

  victron(mod, "vebusState", INVERTING);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0);
});

test("the first republish request waits for the subscriptions to land", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();

  assert.deepStrictEqual(published, [],
    "a keepalive sent in the same breath as the subscriptions loses the burst it asks for");

  const delayed = timers.filter((t) => t.repeat === false).pop();
  assert.strictEqual(delayed.ms, mod.config.initialKeepaliveDelay);

  delayed.fn();
  assert.strictEqual(published[0].payload, "", "the delayed one must ask for a republish");
});

// ===== Picking up the time switch the lead relay already holds =====

// Shelly publishes status only on change; `status_update` on the command topic republishes
function statusUpdates(published, mod) {
  return published.filter((p) => p.topic === mod.config.leadRelay.commandTopic &&
                                 p.payload === "status_update");
}

test("the ask waits for the subscriptions, then goes to the lead's command topic", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();

  assert.deepStrictEqual(statusUpdates(published, mod), [],
    "a request sent in the same breath as the subscription loses the answer it asks for");

  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published, mod).length, 1,
    "the follower assumed the time switch was off instead of asking");
});

test("the follower keeps asking until the lead answers", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();
  const periodic = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  periodic.fn();
  assert.strictEqual(statusUpdates(published, mod).length, 1,
    "one lost request would leave the follower blind for the rest of the window");

  mod.processMqttMessage(mod.state.leadRelayTopic, '{"id":0,"state":true}');
  assert.strictEqual(mod.state.leadInputActive, true);

  published.length = 0;
  periodic.fn();
  assert.deepStrictEqual(statusUpdates(published, mod), [],
    "once answered, stop asking the lead to republish everything every 30 seconds");
});

test("the lead relay does not ask itself", () => {
  const { mod, published, timers } = loadRelay(LEAD_RELAY);

  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.deepStrictEqual(statusUpdates(published, mod), [],
    "its own input is on the device already");
});

test("the shortage lead asks for no time switch", () => {
  const { mod, published, timers } = loadShortageLead();

  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.deepStrictEqual(statusUpdates(published, mod), []);
});

test("a reconnect asks the lead again", () => {
  const { mod, published, timers } = loadImmersion();
  mod.handleMqttConnected();
  mod.processMqttMessage(mod.state.leadRelayTopic, '{"id":0,"state":true}');

  mod.resetMqttData();
  published.length = 0;
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published, mod).length, 1,
    "a follower that kept its answer would ignore a switch that moved while it was down");
});

// ===== The clock jumping =====
// Intervals use uptime. See docs/adr/0003.

test("NTP landing does not expire the startup grace", () => {
  // .209 boots, hears nothing, and the wall clock jumps twelve days
  const { mod, calls } = loadShortageLead();
  settle(mod, true);

  withJumpedWallClock(function () { mod.checkSystemState(); });

  assert.strictEqual(mod.inShortage(), null,
    "a grace measured on the wall clock ended the moment NTP landed");
  assert.deepStrictEqual(switchCommands(calls), [],
    "the heat pump was locked 34 seconds into a boot, for a reading still in flight");
});

test("the grace still ends, on the clock that cannot jump", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);

  advanceClock(mod.config.startupGrace + 1000);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [false],
    "silence past the grace is the trouble the VE.Bus gate exists for");
});

test("a device that cannot read its own uptime lets no interval elapse", () => {
  const { mod, calls } = loadShortageLead();
  settle(mod, true);
  global.Shelly.getComponentStatus = function () { return null; };

  advanceClock(mod.config.startupGrace + 1000);
  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "an unreadable clock was treated as a clock that had run on");
});
