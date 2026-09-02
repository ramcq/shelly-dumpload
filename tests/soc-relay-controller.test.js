// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Covers the two roles this one script runs in: the four DHW immersions, which
// dump surplus, and Heat Pump Enable (.209), which determines shortage. The
// interesting cases are the ones where a dump load's gates would be wrong on the
// heat pump — a generation gate or an overload shed that locks a compressor for
// half an hour — and the shortage thresholds themselves, which exist in this one
// deployment and nowhere else. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./harness.js");

const DUMP = "soc-relay-controller.js";

const HEAT_PUMP_ENABLE = "shelly1minig3-d885ac0a3668"; // .209, no band of its own
const LEAD_RELAY = "shelly1pmg3-543204558fc8"; // .90, Left Bottom, 94/93, time switch
const LEFT_TOP = "shelly1pmg3-543204558c6c"; // .88, 96/95, a plain follower
const HP_LOCK = "shelly1minig3-d885ac0a3668/status/switch:0";
const PORTAL = "c0847dc9a794";

const INVERTING = 9;
const PASSTHRU = 8;

const MINUTES = 60 * 1000;

// One relay from the table, settled as the GetDeviceInfo callback would settle it - the
// harness never runs that callback, since Shelly.call does not call back.
function loadRelay(deviceId) {
  const loaded = load(DUMP);
  assert.strictEqual(loaded.mod.applySettingsForDevice(deviceId), true,
    deviceId + " is not in the relay table");
  loaded.mod.assignFollowedTopics();
  loaded.mod.state.identityKnown = true;
  return loaded;
}

// A plain follower: no time switch on its own input, and it is not the shortage lead.
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

// What .209 publishes: its relay closed means the heat pump is running, open is shortage.
function lock(mod, closed) {
  mod.processMqttMessage(HP_LOCK, JSON.stringify({ id: 0, output: closed }));
}

// Put the controller in a known place, so a test only states what it is varying.
function settle(mod, relayIsOn) {
  mod.state.relayIsOn = relayIsOn;
  mod.state.intendedRelayOn = relayIsOn;
}

// What the controller commanded its own relay to do, if anything. Shelly.call
// never calls back under the harness, so the command is the observable, not the
// resulting state.
function switchCommands(calls) {
  return calls
    .filter((c) => c.method === "Switch.Set")
    .map((c) => c.params.on);
}

// Everything a call printed. The controller logs its status line as well as setting it, and
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

function statusText(mod) {
  return captureLog(function () { mod.updateStatus(); });
}

function bannerText(mod) {
  return captureLog(function () { mod.finishSetup(); });
}

// ===== Role resolution =====

test("identity is resolved before anything else runs", () => {
  // Thresholds, gates and topics all depend on which relay this is, so nothing can
  // happen before the device has matched itself against the table.
  const { calls } = loadImmersion();
  assert.strictEqual(calls[0].method, "Shelly.GetDeviceInfo",
    "startup does something before it knows which device it is on");
});

test("a DHW immersion is not the shortage lead", () => {
  const { mod } = loadRelay(LEAD_RELAY);
  assert.strictEqual(mod.state.isShortageLead, false);
  assert.strictEqual(mod.state.isLeadRelay, true, "the table did not name the lead relay");
});

test("the table carries the stagger the immersions exist to have", () => {
  // A point apart, so they come on in turn rather than all at once. These are the values
  // the sliders held before the table replaced them.
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
  // The immersions carry a persisted number:202 from the script this one replaced, and
  // .209 shares that id with smart-load-controller, whose slider stops at 50.
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

// Three terms, on one device: VE.Bus state, battery SOC and total generation, worked out by
// .209 alone and expressed on its relay. The SOC term is latched between 30 and 90, so what
// the battery did matters; between the two, generation settles a latch that has never been
// resolved. See CONTROLS.md for why the band is that wide.

test("at or below 30 the system is short whatever is generating", () => {
  const { mod } = loadShortageLead();
  victron(mod, "vebusState", INVERTING);
  victron(mod, "acGeneration", 8000);
  victron(mod, "batterySOC", 30);

  assert.strictEqual(mod.inShortage(), true,
    "ten points above the generator autostart, generation is no longer the question");
});

// The loads shortage sheds are the same loads that move SOC, so a memoryless rule would
// cycle at the bottom threshold: shed at 30, recover to 31, un-shed, fall back to 30. With
// 1.5 kW of hydro against a 3 kW heat pump that is a 40-minute cycle, all day.
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

// A controller starting between the thresholds cannot know which way the battery was going,
// so it assumes the safe end and lets generation say otherwise. Mid-band with nothing
// generating is what a degraded system looks like between generator runs, and releasing a
// 3-5 kW heat pump into that is what the assumption exists to prevent.
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

// The two terms are separate, and the latch does not wait on the one that overlays it:
// SOC alone settles it, so a controller that has heard the battery and not yet the inverter
// still knows which side of 30 it is on.
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
  // Mid-band with nothing generating is a shortage as far as .209 is concerned. An
  // immersion is not entitled to that opinion: it acts on the lock or not at all.
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
  // The immersion case is the control: it proves the subscription is there to suppress.
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

// The immersions read one boolean - is the heat pump running - rather than working the
// shortage terms out themselves. That keeps the heating side out of the power system, and
// makes the lock something a person can drive by hand: stop .209's script, set its relay,
// and the followers follow.

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
    "2.7 kW of hot water is not something to make on a flat battery");
});

// Deliberate, and a change from today: the VE.Bus gate sits below the time switch and
// never sees a calling clock, so a generator run currently leaves the timer working. The
// whole lock is honoured instead, and the escape hatch stays in one place - closing .209's
// relay by hand releases the heat pump and the immersions together.
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
  // .90 is in_mode follow, so the time switch closes it in hardware whatever the script
  // wants. A Switch.Set then overrides follow until the next input edge.
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

test("closing the lock gives the time switch back", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  lock(mod, false);
  lock(mod, true);

  assert.deepStrictEqual(switchCommands(calls), [true],
    "the immersions come back on the same edge that unlocks the heat pump");
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

  // A change made while the broker was away is never repeated by either device.
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

// ===== The latch has one durable copy, and .209 keeps it =====

// Nothing but a command moves the contact, so the switch's own last-command source is the
// whole question: `init` is `initial_state` restored at boot and nothing since, which is a
// configuration default rather than a decision.
test("the shortage lead reads its latch off its own relay contact", () => {
  const { mod } = loadShortageLead();
  mod.state.relayIsOn = true; // the contact says: heat pump running, no shortage
  global.Shelly.getComponentStatus = function (key) {
    return key === "switch:0" ? { output: true, source: "MQTT" } : null;
  };

  mod.seedLatchFromRelay();

  assert.strictEqual(mod.state.shortageLatch, false,
    "a redeploy discarded the one durable copy of the latch and assumed shortage");
});

test("a contact nothing has commanded is not a decision", () => {
  // One answer for two cases an uptime reading could not tell apart: a power cut with the
  // script starting straight after it, and a script deployed hours into a boot. Both find
  // a contact still on `initial_state: "on"`, and reading that as a decision releases a
  // 3-5 kW heat pump onto diesel.
  const { mod } = loadShortageLead();
  mod.state.relayIsOn = true;
  global.Shelly.getComponentStatus = function (key) {
    return key === "switch:0" ? { output: true, source: "init" } : null;
  };

  mod.seedLatchFromRelay();

  assert.strictEqual(mod.state.shortageLatch, null,
    "initial_state was read as a released heat pump");
});

test("a contact it cannot read is not a decision either", () => {
  const { mod } = loadShortageLead();
  mod.state.relayIsOn = true;

  mod.seedLatchFromRelay(); // the harness reports no switch status

  assert.strictEqual(mod.state.shortageLatch, null);
});

test("an immersion keeps no latch to read", () => {
  const { mod } = loadImmersion();
  mod.state.relayIsOn = true;
  global.Shelly.getComponentStatus = function (key) {
    return key === "switch:0" ? { output: true, source: "MQTT" } : null;
  };

  mod.seedLatchFromRelay();

  assert.strictEqual(mod.state.shortageLatch, null,
    "an immersion's relay means hot water, not shortage");
});

// ===== What .209 says it is doing =====

test("the shortage lead claims no shortage it has not established", () => {
  // inShortage() has three answers and "nothing heard yet" is one of them. Read as a
  // plain boolean it reads as no shortage, which is the one thing it does not mean.
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

// Every follower of .209 reads its published switch status, so a device with status
// notifications off is a controller whose decision never leaves it.
test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadShortageLead();
  const server = mod.config.cerbo.host + ":" + mod.config.cerbo.port;

  // Connected is the ordinary case: the device's MQTT client is up long before the script
  // starts, so a check that only ran when offline would never run at all.
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
  mod.state.startedAt = Date.now() - (mod.config.startupGrace + 1000);

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

// The two terms are not symmetrical. A battery at 30% is released by reaching 90%; a
// passthrough or a fault at 60% is released by the passthrough or fault ending. Holding
// the second to the first would lock the heat pump until the battery next reached 90% —
// days, on hydro alone — and would present to every follower as a battery shortage.
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

test("an unreadable device ID is retried rather than guessed", () => {
  const { mod, timers, calls } = load(DUMP);
  let attempts = 0;

  global.Shelly.call = function (method, params, callback) {
    calls.push({ method: method, params: params });
    if (method === "Shelly.GetDeviceInfo") {
      attempts++;
      callback(null, -1, "timed out");
    }
  };

  mod.determineDeviceIdentity(function () {});

  assert.strictEqual(attempts, 1);
  assert.strictEqual(mod.state.identityKnown, false);
  const retry = timers.filter((t) => t.repeat === false).pop();
  assert.ok(retry, "no retry was scheduled");
  assert.strictEqual(retry.ms, mod.config.identityRetryDelay);

  retry.fn();
  assert.strictEqual(attempts, 2, "the retry did not ask again");
});

// ===== Losing the broker =====

// Installed on the already-connected path, which is the only path a running device takes:
// without them a controller never learns the broker has gone and the gate goes on reading
// a VE.Bus state frozen hours ago.
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

// The broker publishes nothing until a value changes, so a state that changes only when a
// generator runs is only ever seen in a republish burst — and the subscriptions are not
// reliably live in time for the one the first keepalive triggers. Everything else in the
// topic set changes every few seconds and arrives regardless, so this fails silently on
// exactly one topic: the one the VE.Bus gate depends on.
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

// Shelly publishes status on change and does not retain it, so a follower that has just
// started believes the time switch is off until the lead next moves — hours, for a time
// clock. Publishing `status_update` to the lead's command topic makes it republish every
// component on the topics this controller already subscribes to: the same trick as the
// Victron keepalive above, and it costs no extra subscription and no HTTP.
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

// A broker drop is not just a gap in the data: the time switch may have moved while the
// follower was away, and the lead will not say so again until it next moves.
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
