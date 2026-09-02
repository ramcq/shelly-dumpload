// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Covers the parts of surplus-dump-controller.js that are easy to get wrong and
// expensive to get wrong on live plant: which device a stage commands, how many
// MQTT subscriptions the script holds, and whether one quiet stage can stall the
// rest. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog } = require("./harness.js");

const SCRIPT = "surplus-dump-controller.js";
const HEATER = 2690; // W, nominal per immersion
const PRO2PM = "shellypro2pm-ec6260a03d70"; // immersions 1 and 2
const PRO1PM = "shellypro1pm-5c013b056870"; // immersion 4

function loadController() {
  return load(SCRIPT);
}

// ===== Stage configuration =====

test("three constant stages are configured, immersion 4 last", () => {
  const { mod } = loadController();
  const sw = mod.config.remoteSwitches.switches;

  assert.strictEqual(sw.length, 3);
  assert.deepStrictEqual(
    sw.map((s) => [s.deviceId, s.switchId]),
    [[PRO2PM, 0], [PRO2PM, 1], [PRO1PM, 0]]
  );
});

test("state array is built from the config, not hand-maintained", () => {
  const { mod } = loadController();
  assert.strictEqual(
    mod.state.remoteSwitches.length,
    mod.config.remoteSwitches.switches.length
  );
});

// ===== Surplus allocation =====

test("surplus allocates sequentially across all three stages", () => {
  const { mod } = loadController();
  const desired = mod.calculateDesiredState(3 * HEATER + 500);

  assert.deepStrictEqual(desired.switches, [true, true, true]);
  assert.ok(desired.intendedPower >= 3 * HEATER);
});

test("two heaters' worth of surplus leaves the third stage off", () => {
  const { mod } = loadController();
  assert.deepStrictEqual(
    mod.calculateDesiredState(2 * HEATER + 100).switches,
    [true, true, false]
  );
});

test("surplus below one heater leaves every constant stage off", () => {
  const { mod } = loadController();
  assert.deepStrictEqual(
    mod.calculateDesiredState(HEATER - 200).switches,
    [false, false, false]
  );
});

// ===== Addressing: index is not the device channel =====

test("stage index maps to the right device and channel", () => {
  const { mod, published } = loadController();
  mod.state.mqttConnected = true;

  mod.sendRemoteSwitchCommand(0, true, "test");
  mod.sendRemoteSwitchCommand(1, true, "test");
  mod.sendRemoteSwitchCommand(2, true, "test");

  assert.strictEqual(published[0].topic, PRO2PM + "/rpc");
  assert.strictEqual(JSON.parse(published[0].payload).params.id, 0);

  assert.strictEqual(published[1].topic, PRO2PM + "/rpc");
  assert.strictEqual(JSON.parse(published[1].payload).params.id, 1);

  // Stage 2 is channel 0 on a different device, not channel 2 on the Pro 2PM.
  assert.strictEqual(published[2].topic, PRO1PM + "/rpc");
  assert.strictEqual(JSON.parse(published[2].payload).params.id, 0);
});

test("suppressAllLoads turns off all three stages", () => {
  const { mod, published } = loadController();
  mod.state.mqttConnected = true;
  mod.state.remoteSwitches.forEach((s) => { s.on = true; });

  mod.suppressAllLoads("test");

  const commands = published
    .filter((p) => p.topic.endsWith("/rpc"))
    .map((p) => JSON.parse(p.payload));

  assert.strictEqual(commands.length, 3);
  commands.forEach((c) => assert.strictEqual(c.params.on, false));
  assert.strictEqual(published[2].topic, PRO1PM + "/rpc");
});

// ===== Status routing =====

test("channel 0 on each device routes to its own stage", () => {
  const { mod } = loadController();

  mod.processMqttMessage(PRO2PM + "/status/switch:0",
    JSON.stringify({ output: true, apower: 2700, voltage: 230 }));
  mod.processMqttMessage(PRO1PM + "/status/switch:0",
    JSON.stringify({ output: true, apower: 2680, voltage: 231 }));

  assert.strictEqual(mod.state.remoteSwitches[0].power, 2700);
  assert.strictEqual(mod.state.remoteSwitches[1].statusReceived, false);
  assert.strictEqual(mod.state.remoteSwitches[2].power, 2680);
});

test("immersion 4 power counts toward total dump power", () => {
  const { mod } = loadController();
  mod.processMqttMessage(PRO1PM + "/status/switch:0",
    JSON.stringify({ output: true, apower: 2680, voltage: 231 }));

  assert.strictEqual(mod.getDumpLoadPower(), 2680);
});

test("non-switch topics from the device wildcard are ignored", () => {
  const { mod } = loadController();
  mod.processMqttMessage(PRO1PM + "/status/input:0",
    JSON.stringify({ id: 0, state: true }));

  mod.state.remoteSwitches.forEach((s) => {
    assert.strictEqual(s.statusReceived, false);
  });
});

// ===== MQTT subscription budget =====
// A Shelly script may hold ten subscriptions; the eleventh throws "Too many
// subscriptions" and the script does not run at all.

test("stays within Shelly's ten-subscription cap", () => {
  const { mod, subscribed } = loadController();
  mod.setupMqttSubscriptionsAndKeepalive();

  assert.ok(subscribed.length <= 10,
    "subscribed to " + subscribed.length + ": " + subscribed.join(", "));
});

test("one wildcard subscription per device, not per stage", () => {
  const { mod, subscribed } = loadController();
  mod.setupMqttSubscriptionsAndKeepalive();

  const deviceSubs = subscribed.filter((t) => t.indexOf("/status/+") !== -1).sort();
  assert.deepStrictEqual(deviceSubs,
    [PRO1PM + "/status/+", PRO2PM + "/status/+"].sort());
});

test("every matched Victron path is still covered by a subscription", () => {
  const { mod, subscribed } = loadController();
  mod.setupMqttSubscriptionsAndKeepalive();
  const prefix = "N/" + mod.config.cerbo.portalId + "/";

  Object.keys(mod.config.victron).forEach((key) => {
    const topic = prefix + mod.config.victron[key];
    const covered = subscribed.some((t) =>
      t === topic || (t.endsWith("/#") && topic.startsWith(t.slice(0, -1))));

    assert.ok(covered, key + " (" + mod.config.victron[key] + ") is not subscribed");
  });
});

// ===== Initialisation =====
// Shelly publishes switch status on change and does not retain it, so a stage
// that has not switched recently may stay silent for a long time.

test("initialisation waits for all three stages to report", () => {
  const { mod } = loadController();
  mod.processMqttMessage(PRO2PM + "/status/switch:0", JSON.stringify({ output: false }));
  mod.processMqttMessage(PRO2PM + "/status/switch:1", JSON.stringify({ output: false }));

  assert.strictEqual(
    mod.state.remoteSwitches.filter((s) => s.statusReceived).length, 2);
});

test("a silent stage does not gate the others forever", () => {
  const { mod } = loadController();
  mod.state.mqttConnected = true;
  mod.state.vebusState = 9;
  mod.state.batterySOC = 98;

  mod.processMqttMessage(PRO2PM + "/status/switch:0", JSON.stringify({ output: false }));
  mod.processMqttMessage(PRO2PM + "/status/switch:1", JSON.stringify({ output: false }));

  mod.checkSystemState();
  assert.strictEqual(mod.state.initialized, false, "should still be waiting");

  mod.state.firstIncompleteCheck = Date.now() - mod.config.statusSeedTimeout - 1000;
  mod.checkSystemState();

  assert.strictEqual(mod.state.initialized, true,
    "must control once the bounded wait expires");
});

test("a broker reconnect re-arms the bounded wait", () => {
  const { mod } = loadController();
  mod.state.firstIncompleteCheck = 12345;

  mod.resetMqttData();

  assert.strictEqual(mod.state.firstIncompleteCheck, 0);
  mod.state.remoteSwitches.forEach((s) => {
    assert.strictEqual(s.statusReceived, false);
  });
});

// ===== Seeding the VE.Bus state =====

// The broker publishes nothing until a value changes, and this one changes only when a
// generator runs - months apart - so it is only ever seen in the burst a republish
// produces. Everything else in the topic set changes every few seconds and arrives
// regardless, which is what makes the miss invisible: measured on the live broker over 70
// seconds, `vebus/276/State` did not arrive once. Miss it and Priority 1 suppresses every
// stage until the next generator run.
const PORTAL = "c0847dc9a794";
const INVERTING = 9;

function victron(mod, key, value) {
  mod.processMqttMessage("N/" + PORTAL + "/" + mod.config.victron[key],
    JSON.stringify({ value: value }));
}

test("the first republish request waits for a turn of the main loop", () => {
  const { mod, published, timers } = loadController();
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

test("keepalives keep asking for a republish until VE.Bus has been seen", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();

  const keepalive = timers.filter((t) => t.repeat === true).pop();
  assert.ok(keepalive, "no periodic keepalive was scheduled");

  published.length = 0;
  keepalive.fn();
  assert.strictEqual(published[0].payload, "",
    "one lost burst would suppress every stage until the next generator run");

  victron(mod, "vebusState", INVERTING);
  published.length = 0;
  keepalive.fn();
  assert.ok(published[0].payload.indexOf("suppress-republish") >= 0,
    "once seen, stop asking the whole system to republish every 30 seconds");
});

test("a broker drop makes the VE.Bus state unknown again", () => {
  const { mod } = loadController();
  victron(mod, "vebusState", INVERTING);
  assert.strictEqual(mod.state.vebusReceived, true);

  mod.resetMqttData();

  assert.strictEqual(mod.state.vebusReceived, false);
  assert.strictEqual(mod.state.vebusState, 0);
});

// ===== Asking the stages to report =====

// A PM channel cannot stay quiet for long - measured on the live broker, an immersion at
// thermal cutout republished its switch status every 20-30 seconds without switching - but
// a stage that is off may say nothing at all, and until every stage has reported this
// controller touches none of them.
function statusUpdates(published) {
  return published.filter((p) => p.payload === "status_update").map((p) => p.topic);
}

function receive(mod, deviceId, switchId, on) {
  mod.processMqttMessage(deviceId + "/status/switch:" + switchId,
    JSON.stringify({ output: on }));
}

test("the ask waits for the main loop, then goes to each device's command topic", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();

  assert.deepStrictEqual(statusUpdates(published), [],
    "a request sent in the same breath as the subscription loses the answer it asks for");

  timers.filter((t) => t.repeat === false).pop().fn();

  assert.deepStrictEqual(statusUpdates(published).sort(),
    [PRO1PM + "/command", PRO2PM + "/command"],
    "the controller waited out statusSeedTimeout instead of asking");
});

test("one ask per device, not per stage", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published).filter((t) => t === PRO2PM + "/command").length,
    1, "immersions 1 and 2 share a device, and one republish carries both channels");
});

test("a device is still asked while one of its two stages is unheard", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();
  receive(mod, PRO2PM, 0, true);

  published.length = 0;
  timers.filter((t) => t.repeat === true).pop().fn();

  assert.ok(statusUpdates(published).includes(PRO2PM + "/command"),
    "immersion 2 would stay unheard because immersion 1 had answered");
});

test("the controller keeps asking until every stage answers", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();
  const periodic = timers.filter((t) => t.repeat === true).pop();

  published.length = 0;
  periodic.fn();
  assert.strictEqual(statusUpdates(published).length, 2,
    "one lost request would leave the whole controller waiting out its bounded wait");

  receive(mod, PRO2PM, 0, true);
  receive(mod, PRO2PM, 1, false);
  receive(mod, PRO1PM, 0, false);

  published.length = 0;
  periodic.fn();
  assert.deepStrictEqual(statusUpdates(published), [],
    "once answered, stop asking every device to republish every 30 seconds");
});

// A stage may have been switched by hand while the broker was away, and nothing will
// repeat it: the reading afterwards is unknown, not merely old.
test("a reconnect asks every device again", () => {
  const { mod, published, timers } = loadController();
  mod.handleMqttConnected();
  receive(mod, PRO2PM, 0, true);
  receive(mod, PRO2PM, 1, true);
  receive(mod, PRO1PM, 0, true);

  mod.resetMqttData();
  published.length = 0;
  mod.handleMqttConnected();
  timers.filter((t) => t.repeat === false).pop().fn();

  assert.strictEqual(statusUpdates(published).length, 2,
    "a controller that kept its answers would trust a stage that had moved since");
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

// This device's own light:0 is buffer immersion 3, and the thermal dump controller watches
// its published status for a cutout it has no other way of seeing.
test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = loadController();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: false });

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1,
    "immersion 3 was left able to boil with nothing watching it");
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured or rebooted", () => {
  const { mod, calls } = loadController();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: true });

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "a settled device must not reboot on every script start");
});

test("a firmware without a status notification setting is not rebooted", () => {
  const { mod, calls } = loadController();
  connectedWith({ enable: true, server: serverFor(mod) }); // no status_ntf key at all

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "an absent key would reboot the device on every script start, forever");
});

test("a disconnect handler is installed even when MQTT is already connected", () => {
  const { mod, handlers } = loadController();
  connectedWith({ enable: true, server: serverFor(mod), status_ntf: true });
  victron(mod, "vebusState", INVERTING);

  mod.connectMqtt();
  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");

  handlers.disconnect();
  assert.strictEqual(mod.state.vebusReceived, false,
    "a lost broker must not leave a state nobody will repeat");
  assert.strictEqual(mod.state.mqttConnected, false);
});

test("the status line tells an unheard VE.Bus state from Off", () => {
  const { mod } = loadController();

  assert.ok(captureLog(function () { mod.updateStatus(); }).indexOf("VE:?") >= 0,
    "never having been told reads as an inverter that is off, and gets diagnosed as one");

  victron(mod, "vebusState", INVERTING);
  assert.ok(captureLog(function () { mod.updateStatus(); }).indexOf("VE:Inverting") >= 0);
});
