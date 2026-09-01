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

const DUMP = "dump-load-controller.js";

const HEAT_PUMP_ENABLE = "shelly1minig3-d885ac0a3668"; // .209
const LEAD_RELAY = "shellypmg3-543204558fc8"; // .90, Left Bottom
const PORTAL = "c0847dc9a794";

const INVERTING = 9;
const PASSTHRU = 8;

const MINUTES = 60 * 1000;

// A DHW immersion: the file as deployed, no role applied. The harness never runs the
// GetDeviceInfo callback, so identity is settled here as that callback would.
function loadImmersion() {
  const loaded = load(DUMP);
  loaded.mod.assignLeadRelayTopic();
  loaded.mod.state.identityKnown = true;
  return loaded;
}

// The shortage lead, with its role resolved from its device ID as at startup.
function loadShortageLead() {
  const loaded = load(DUMP);
  assert.strictEqual(
    loaded.mod.applyRoleForDevice(HEAT_PUMP_ENABLE), true,
    "the heat pump enable relay was not recognised as the shortage lead");
  loaded.mod.assignLeadRelayTopic();
  loaded.mod.state.identityKnown = true;
  return loaded;
}

function victron(mod, key, value) {
  mod.processMqttMessage(
    "N/" + PORTAL + "/" + mod.config.topics[key],
    JSON.stringify({ value: value }));
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

// ===== Role resolution =====

test("identity is resolved before the virtual components are created", () => {
  // The role decides the threshold a persisted component is created with, so it
  // cannot be resolved after the component already exists with the wrong default.
  const { calls } = loadImmersion();
  assert.strictEqual(calls[0].method, "Shelly.GetDeviceInfo",
    "startup does something before it knows which device it is on");
});

test("a DHW immersion is not the shortage lead", () => {
  const { mod } = loadImmersion();
  assert.strictEqual(mod.applyRoleForDevice(LEAD_RELAY), false);
  assert.strictEqual(mod.state.isShortageLead, false);
});

test("an immersion's low threshold is one point below its high threshold", () => {
  const { mod } = loadImmersion();
  assert.strictEqual(mod.config.soc.lowThreshold, null,
    "an immersion derives its low threshold and must not pin one");
  assert.strictEqual(mod.state.lowSocThreshold, mod.state.highSocThreshold - 1);
});

test("the shortage thresholds are 90 to leave and 30 to enter", () => {
  const { mod } = loadShortageLead();
  assert.strictEqual(mod.state.highSocThreshold, 90);
  assert.strictEqual(mod.state.lowSocThreshold, 30);
});

test("no dwell timers in either role", () => {
  ["minOnTime", "minOffTime"].forEach((knob) => {
    assert.strictEqual(loadImmersion().mod.config[knob], undefined, knob);
    assert.strictEqual(loadShortageLead().mod.config[knob], undefined, knob);
  });
});

test("an immersion gets a threshold slider, the shortage lead does not", () => {
  const immersion = loadImmersion();
  immersion.mod.setupVirtualComponents([]);
  const immersionNumbers = immersion.calls
    .filter((c) => c.method === "Virtual.Add" && c.params.type === "number");
  assert.strictEqual(immersionNumbers.length, 1);
  assert.strictEqual(immersionNumbers[0].params.config.default_value, 95);

  // Component 202 is shared with smart-load-controller and its slider stops at 50, so it
  // can neither express the 30% entry nor be trusted not to carry a stale value.
  const heatPump = loadShortageLead();
  heatPump.mod.setupVirtualComponents([]);
  assert.deepStrictEqual(
    heatPump.calls.filter((c) => c.method === "Virtual.Add" && c.params.type === "number"), [],
    "the shortage thresholds must live in the file, not in a slider");

  const group = heatPump.calls
    .filter((c) => c.method === "Virtual.Add" && c.params.type === "group")[0];
  assert.deepStrictEqual(group.params.config.components, ["text:204"]);
  assert.strictEqual(group.params.config.name, "Heat Pump Enable");
});

test("the shortage lead ignores a threshold component that already exists", () => {
  const { mod } = loadShortageLead();
  global.Virtual.getHandle = function () {
    return { getValue: function () { return 95; }, on: function () {} };
  };

  mod.finishSetup();

  assert.strictEqual(mod.state.highSocThreshold, 90,
    "a stale persisted slider moved the shortage exit threshold");
  assert.strictEqual(mod.state.lowSocThreshold, 30);
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
  assert.ok(immersion.subscribed.length > 5, "the immersion's lead topic was not counted");
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

test("the manual time switch turns an immersion on regardless of SOC", () => {
  const { mod, calls } = loadImmersion();
  settle(mod, false);
  mod.state.leadInputActive = true;
  victron(mod, "vebusState", INVERTING);
  victron(mod, "batterySOC", 50);

  mod.checkSystemState();
  assert.deepStrictEqual(switchCommands(calls), [true],
    "someone asking for hot water is not second-guessed against the battery");
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
