// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Covers thermal cutout detection across the buffer immersions: every stage the
// surplus controller can switch must be watched here, or it cuts out with nothing
// to recover it. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog } = require("./harness.js");

const THERMAL = "thermal-dump-controller.js";
const SURPLUS = "surplus-dump-controller.js";

const IMMERSION_4 = "shellypro1pm-5c013b056870/status/switch:0";

function loadThermal() {
  return load(THERMAL);
}

// A load at thermal cutout: relay closed, mains present, drawing nothing.
const STALLED = { output: true, voltage: 230, apower: 0 };
const HEATING = { output: true, voltage: 230, apower: 2690 };

// ===== Watched loads =====

test("all four buffer immersions are watched", () => {
  const { mod } = loadThermal();
  assert.strictEqual(mod.config.dumpLoads.length, 4);
  assert.ok(mod.config.dumpLoads.some((l) => l.statusTopic === IMMERSION_4),
    "immersion 4 is not watched for thermal cutout");
});

test("state array is built from the config", () => {
  const { mod } = loadThermal();
  assert.strictEqual(mod.state.dumpLoads.length, mod.config.dumpLoads.length);
});

test("watched topics are unique", () => {
  const { mod } = loadThermal();
  const topics = mod.config.dumpLoads.map((l) => l.statusTopic);
  assert.strictEqual(new Set(topics).size, topics.length);
});

// This is the coupling that silently rots: a stage can be added to the surplus
// controller and switched on live plant without anything here noticing it.
test("every switchable surplus stage is watched for cutout", () => {
  const { mod: thermal } = loadThermal();
  const { mod: surplus } = load(SURPLUS);

  const watched = thermal.config.dumpLoads.map((l) => l.statusTopic);

  surplus.config.remoteSwitches.switches.forEach((sw) => {
    const topic = sw.deviceId + "/status/switch:" + sw.switchId;
    assert.ok(watched.includes(topic),
      sw.name + " (" + topic + ") is switchable but not watched for thermal cutout");
  });
});

// ===== Cutout detection =====

test("immersion 4 at thermal cutout is detected", () => {
  const { mod } = loadThermal();
  mod.processMqttMessage(IMMERSION_4, JSON.stringify(STALLED));

  assert.strictEqual(mod.isDumpLoadStalled(), true);
  assert.strictEqual(mod.getDumpLoadState(), "STALLED");
});

test("immersion 4 heating normally is not a cutout", () => {
  const { mod } = loadThermal();
  mod.processMqttMessage(IMMERSION_4, JSON.stringify(HEATING));

  assert.strictEqual(mod.isDumpLoadStalled(), false);
  assert.strictEqual(mod.getDumpLoadState(), "ON");
});

test("immersion 4 off with no voltage is not a cutout", () => {
  const { mod } = loadThermal();
  mod.processMqttMessage(IMMERSION_4,
    JSON.stringify({ output: false, voltage: 0, apower: 0 }));

  assert.strictEqual(mod.isDumpLoadStalled(), false);
  assert.strictEqual(mod.getDumpLoadState(), "OFF");
});

test("a cutout on immersion 4 is seen while the others are heating", () => {
  const { mod } = loadThermal();
  const loads = mod.config.dumpLoads;

  loads.forEach((l) => {
    mod.processMqttMessage(l.statusTopic,
      JSON.stringify(l.statusTopic === IMMERSION_4 ? STALLED : HEATING));
  });

  // STALLED must win over the others still drawing power, or the fan coil
  // never runs and the cut-out immersion never recovers.
  assert.strictEqual(mod.getDumpLoadState(), "STALLED");
});

test("status routes to the right stage", () => {
  const { mod } = loadThermal();
  const index = mod.config.dumpLoads.findIndex((l) => l.statusTopic === IMMERSION_4);

  mod.processMqttMessage(IMMERSION_4, JSON.stringify(STALLED));

  assert.strictEqual(mod.state.dumpLoads[index].power, 0);
  assert.strictEqual(mod.state.dumpLoads[index].voltage, 230);
  mod.state.dumpLoads.forEach((l, i) => {
    if (i !== index) assert.strictEqual(l.voltage, 0, "stage " + i + " was written to");
  });
});

// ===== Subscription budget =====

test("stays within Shelly's ten-subscription cap", () => {
  const { mod, subscribed } = loadThermal();
  mod.setupMqttSubscriptionsAndKeepalive();

  assert.ok(subscribed.length <= 10,
    "subscribed to " + subscribed.length + ": " + subscribed.join(", "));
});

test("every watched load is subscribed to", () => {
  const { mod, subscribed } = loadThermal();
  mod.setupMqttSubscriptionsAndKeepalive();

  mod.config.dumpLoads.forEach((l) => {
    assert.ok(subscribed.includes(l.statusTopic), l.name + " is not subscribed");
  });
});

// ===== Seeding the boiler state =====

// The boiler input moves only when the boiler starts or stops firing, and the Victron
// broker publishes nothing until a value changes, so a controller starting up between
// transitions hears nothing at all: measured over 70 seconds on the live broker, with
// power to spare and the boiler cold, the tank temperatures arrived four times each and
// `digitalinput/102/State` never. It is therefore only ever seen in the burst a republish
// produces - the one this controller used to ask for in the same breath as its own
// subscriptions.
const PORTAL = "c0847dc9a794";
const BOILER_RUNNING = 10;
const BOILER_STOPPED = 11;

function victron(mod, key, value) {
  mod.processMqttMessage("N/" + PORTAL + "/" + mod.config.topics[key],
    JSON.stringify({ value: value }));
}

// Hot buffer, one immersion at cutout: everything the thermal dump needs except an answer
// about the boiler.
function readyToDump(mod) {
  victron(mod, "topTankTemp", 80);
  victron(mod, "bottomTankTemp", 78);
  mod.processMqttMessage(IMMERSION_4, JSON.stringify(STALLED));
}

function switchCommands(calls) {
  return calls.filter((c) => c.method === "Switch.Set").map((c) => c.params);
}

test("the first republish request waits for a turn of the main loop", () => {
  const { mod, published, timers } = loadThermal();
  mod.handleMqttConnected();

  assert.deepStrictEqual(published, [],
    "a request sent in the same breath as MQTT.subscribe is answered before anything is " +
    "listening");

  const delayed = timers.filter((t) => t.repeat === false).pop();
  assert.strictEqual(delayed.ms, mod.config.initialKeepaliveDelay);

  delayed.fn();
  assert.strictEqual(published[0].payload, "",
    "an empty payload is what asks the broker to republish everything");
});

test("keepalives keep asking for a republish until the silent readings are seen", () => {
  const { mod, published, timers } = loadThermal();
  mod.handleMqttConnected();

  const keepalive = timers.filter((t) => t.repeat === true).pop();
  assert.ok(keepalive, "no periodic keepalive was scheduled");

  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "",
    "one lost burst would leave the boiler state unknown until it next changed");

  victron(mod, "boilerOperating", BOILER_STOPPED);
  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "",
    "the bridge state is as silent as the boiler input, and qualifies all three readings");

  bridge(mod, true);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0,
    "once seen, stop asking the whole system to republish every 30 seconds");
});

// ===== The bridge behind every Fröling reading =====

// dbus-froeling holds the last temperature and the last boiler state when modbus drops, so
// both keep arriving and keep looking fresh. Recovering waste heat is a power system
// optimisation, so losing sight of the boiler suppresses it rather than degrading it.
function bridge(mod, connected) {
  victron(mod, "froelingConnected", connected ? 1 : 0);
}

// Which outputs were commanded on. switchCommands() here yields {id, on} params rather than
// bare booleans, so a test that reaches for a boolean in it never matches anything.
function turnedOn(calls) {
  return switchCommands(calls).filter((p) => p.on).map((p) => p.id).sort();
}

test("a bridge that cannot read the boiler suspends the thermal dump", () => {
  const { mod, calls } = loadThermal();
  readyToDump(mod);
  victron(mod, "boilerOperating", BOILER_STOPPED);
  bridge(mod, true);
  mod.checkSystemState();
  assert.notDeepStrictEqual(switchCommands(calls), [], "nothing was dumping to begin with");

  calls.length = 0;
  bridge(mod, false);
  mod.checkSystemState();

  assert.deepStrictEqual(turnedOn(calls), [],
    "kept dumping into a tank nobody could read, with the boiler state held");
});

test("a republish burst does not revive a held reading", () => {
  // The bridge holds its last values, so a full republish re-delivers all of them looking
  // exactly as they did when they were live. Suppression has to be a property of the
  // readings, not an event that happened once when /Connected moved.
  const { mod, calls } = loadThermal();
  readyToDump(mod);
  victron(mod, "boilerOperating", BOILER_STOPPED);
  bridge(mod, true);
  bridge(mod, false);

  // What the Cerbo sends back on the next keepalive: every held value, unchanged.
  victron(mod, "topTankTemp", 80);
  victron(mod, "bottomTankTemp", 76);
  victron(mod, "boilerOperating", BOILER_STOPPED);

  calls.length = 0;
  mod.checkSystemState();

  assert.deepStrictEqual(turnedOn(calls), [],
    "a republish of the held readings put the thermal dump back to work");
});

test("a held tank temperature is shown as no reading rather than as a number", () => {
  const { mod } = loadThermal();
  readyToDump(mod);
  victron(mod, "topTankTemp", 80);
  bridge(mod, false);

  const text = captureLog(function () { mod.updateStatus(); });
  assert.ok(text.indexOf("Tank:?") >= 0, text);
});

// Dumping heat is a power system optimisation; the boiler making that heat is not. So an
// unheard state counts as a running boiler.
test("an unheard boiler state inhibits the thermal dump", () => {
  const { mod, calls } = loadThermal();
  readyToDump(mod);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), [],
    "the pump ran on the assumption that a boiler nobody has heard from is stopped");
});

test("the boiler state arriving lifts the inhibition", () => {
  const { mod, calls } = loadThermal();
  readyToDump(mod);
  victron(mod, "boilerOperating", BOILER_STOPPED);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls),
    [{ id: 1, on: true }, { id: 0, on: true }],
    "a stalled immersion with a hot tank and a stopped boiler must be recovered");
});

test("a running boiler still inhibits the dump once heard", () => {
  const { mod, calls } = loadThermal();
  readyToDump(mod);
  victron(mod, "boilerOperating", BOILER_RUNNING);

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(calls), []);
});

// A change made while the broker was away is never repeated, so the reading afterwards is
// unknown rather than merely old.
test("a broker drop makes the boiler state unknown again", () => {
  const { mod } = loadThermal();
  victron(mod, "boilerOperating", BOILER_STOPPED);
  assert.strictEqual(mod.state.boilerReceived, true);

  mod.resetMqttData();

  assert.strictEqual(mod.state.boilerReceived, false);
  assert.strictEqual(mod.state.boilerOperating, false);
});

// ===== The device's own MQTT config =====

// Connected is the ordinary case: the device's MQTT client is up long before the script
// starts, so a check that only ran when offline would never run at all - which is where
// this one used to sit.
function connectedWith(mqttConfig) {
  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () { return mqttConfig; };
}

function serverFor(mod) {
  return mod.config.cerbo.host + ":" + mod.config.cerbo.port;
}

test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadThermal();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: false });

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1, "the device was left publishing nothing");
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured or rebooted", () => {
  const { mod, calls } = loadThermal();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: true });

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "a settled device must not reboot on every script start");
});

test("a firmware without a status notification setting is not rebooted", () => {
  const { mod, calls } = loadThermal();
  connectedWith({ enable: true, server: serverFor(mod) }); // no status_ntf key at all

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "an absent key would reboot the device on every script start, forever");
});

test("a disconnect handler is installed even when MQTT is already connected", () => {
  const { mod, handlers } = loadThermal();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: true });
  victron(mod, "boilerOperating", BOILER_RUNNING);

  mod.connectMqtt();
  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");

  handlers.disconnect();
  assert.strictEqual(mod.state.boilerReceived, false,
    "a lost broker must not leave a state nobody will repeat");
  assert.strictEqual(mod.state.mqttConnected, false);
});

test("the status line tells an unheard boiler from a stopped one", () => {
  const { mod } = loadThermal();

  assert.ok(captureLog(function () { mod.updateStatus(); }).indexOf("Boiler:?") >= 0,
    "unknown and stopped read the same, and only one of them permits dumping");

  victron(mod, "boilerOperating", BOILER_STOPPED);
  assert.ok(captureLog(function () { mod.updateStatus(); }).indexOf("Boiler:OFF") >= 0);
});

// ===== Intended state, and why the handler reads it =====
//
// Two things move these relays: this script, and the firmware acting on the
// device's own input. Both arrive back as the same toggle event, and the handler
// used to answer every one of them by reading the switch over RPC and running the
// control logic - inside an event handler, which is how an RPC callback came to
// re-enter it. Recording what was asked for before asking for it makes the two
// tellable apart without a call: a toggle that matches the intention is this
// script's own echo and stops there, and only a toggle that does not is a change
// to reconcile.

// The handler the device would deliver events to. finishSetup() installs it, and
// finishSetup does not run under the harness, so a test installs it directly.
function eventHandler(loaded) {
  loaded.mod.setupEventHandlers();
  return loaded.handlers.event;
}

function toggle(id, on) {
  return { name: "switch", info: { event: "toggle", id: id, state: on } };
}

test("a toggle this controller asked for is its own echo and stops there", () => {
  const loaded = loadThermal();
  const fire = eventHandler(loaded);
  loaded.mod.turnOutputOn(0, "test");   // sets intended, RPC never answers

  const log = captureLog(() => fire(toggle(0, true)));

  assert.strictEqual(loaded.mod.getOutput(0).on, true, "the actual state still follows");
  assert.ok(log.indexOf("Fan Coil changed") !== -1, log);
  assert.ok(log.indexOf("Monitoring") === -1,
    "running the control logic from inside the event it caused is the re-entrancy: " + log);
});

test("a relay moved at the device is reconciled instead", () => {
  const loaded = loadThermal();
  const fire = eventHandler(loaded);
  // Nothing was asked for, so intended is false and a relay that has come on is
  // somebody else's doing - the thermostat wired to the fan coil, most likely.

  const log = captureLog(() => fire(toggle(0, true)));

  assert.strictEqual(loaded.mod.getOutput(0).on, true);
  assert.strictEqual(loaded.mod.getOutput(0).intended, true,
    "the intention is resynced, or every later echo reads as external too");
  assert.ok(log.indexOf("changed externally") !== -1, log);
  assert.ok(log.indexOf("Monitoring") !== -1,
    "an external change is the one thing that does need reconciling: " + log);
});

test("an unknown switch id is ignored rather than reconciled", () => {
  const loaded = loadThermal();
  const fire = eventHandler(loaded);

  const log = captureLog(() => fire(toggle(7, true)));

  assert.ok(log.indexOf("unknown switch ID") !== -1, log);
  assert.ok(log.indexOf("Monitoring") === -1, log);
});

test("startup takes the intention from the relay, so the first toggle is not read as external", () => {
  const loaded = loadThermal();
  global.Shelly.getComponentStatus = function () { return { output: true }; };
  loaded.mod.updateOutputStates();

  loaded.mod.state.outputs.forEach((o) => {
    assert.strictEqual(o.intended, true,
      "a relay found closed was intended closed by whatever closed it; assuming " +
      "otherwise makes the next echo a reconciliation");
  });
  global.Shelly.getComponentStatus = function () { return null; };
});

// ===== Minimum run time =====
//
// Five minutes, and it is one-directional like the boiler's: starting the fan coil
// and pump costs nothing, stopping them a minute later means the heat they moved
// is still in the coil and the immersion that cut out has not cooled enough to
// reset. Nothing delays a start.

test("an output that has just started is not stopped inside five minutes", () => {
  const { mod, calls } = loadThermal();
  const output = mod.getOutput(0);
  output.on = true;
  output.intended = true;
  output.onTime = Date.now() - 60 * 1000;

  mod.turnOutputOff(0, "test");

  assert.deepStrictEqual(switchCommands(calls), [],
    "the RPC is not sent at all, so the intention is not moved either");
  assert.strictEqual(output.intended, true);
});

test("past five minutes it stops", () => {
  const { mod, calls } = loadThermal();
  const output = mod.getOutput(0);
  output.on = true;
  output.intended = true;
  output.onTime = Date.now() - mod.config.minRunTime - 1000;

  mod.turnOutputOff(0, "test");

  assert.deepStrictEqual(switchCommands(calls), [{ id: 0, on: false }]);
  assert.strictEqual(output.intended, false,
    "intended moves before the RPC, so the echo that comes back is recognised");
});

test("nothing delays a start", () => {
  const { mod, calls } = loadThermal();
  mod.getOutput(0).onTime = Date.now();

  mod.turnOutputOn(0, "test");

  assert.deepStrictEqual(switchCommands(calls), [{ id: 0, on: true }]);
});
