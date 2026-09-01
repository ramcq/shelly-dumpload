// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Covers what has to work for one controller's decision to reach another: the device's
// own MQTT config, and noticing that the broker has gone away. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./harness.js");

const DUMP = "dump-load-controller.js";
const PORTAL = "c0847dc9a794";

function victron(mod, key, value) {
  mod.processMqttMessage(
    "N/" + PORTAL + "/" + mod.config.topics[key],
    JSON.stringify({ value: value }));
}

// Connected is the ordinary case: the device's MQTT client is up long before the script
// starts, so anything behind an "already connected" early return never runs at all.
function connected(mod, mqttConfig) {
  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () { return mqttConfig; };
}

function serverFor(mod) {
  return mod.config.cerbo.host + ":" + mod.config.cerbo.port;
}

test("status notifications are turned on if the device has them off", () => {
  const { mod, calls } = load(DUMP);
  connected(mod, { enable: true, server: serverFor(mod), status_ntf: false });

  mod.connectMqtt();

  const setConfig = calls.filter((c) => c.method === "MQTT.SetConfig");
  assert.strictEqual(setConfig.length, 1, "the device was left publishing nothing");
  assert.strictEqual(setConfig[0].params.config.status_ntf, true);
});

test("an already-configured device is not reconfigured or rebooted", () => {
  const { mod, calls } = load(DUMP);
  connected(mod, { enable: true, server: serverFor(mod), status_ntf: true });

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "a settled device must not reboot on every script start");
});

test("a firmware without a status notification setting is not rebooted", () => {
  const { mod, calls } = load(DUMP);
  connected(mod, { enable: true, server: serverFor(mod) }); // no status_ntf key at all

  mod.connectMqtt();

  assert.deepStrictEqual(
    calls.filter((c) => c.method === "MQTT.SetConfig" || c.method === "Shelly.Reboot"), [],
    "an absent key would reboot the device on every script start, forever");
});

test("a disconnect handler is installed even when MQTT is already connected", () => {
  const { mod, handlers } = load(DUMP);
  connected(mod, { enable: true, server: serverFor(mod), status_ntf: true });
  victron(mod, "vebusState", 9);

  mod.connectMqtt();
  assert.strictEqual(typeof handlers.disconnect, "function",
    "nothing would ever notice the broker going away");

  handlers.disconnect();
  assert.strictEqual(mod.state.vebusState, 0, "a lost broker must not leave a stale state");
  assert.strictEqual(mod.state.mqttConnected, false);
});

// ===== Shedding =====

test("an immersion sheds the moment SOC falls", () => {
  const { mod, calls } = load(DUMP);
  mod.state.relayIsOn = true;
  mod.state.intendedRelayOn = true;
  victron(mod, "vebusState", 9);
  victron(mod, "acGeneration", 3000);
  victron(mod, "batterySOC", 94);

  mod.checkSystemState();
  assert.deepStrictEqual(
    calls.filter((c) => c.method === "Switch.Set").map((c) => c.params.on), [false],
    "a hydro trip must not wait out a dwell before 2.7 kW comes off the inverter");
});

test("there is no minimum on time", () => {
  const { mod } = load(DUMP);
  assert.strictEqual(mod.config.minOnTime, undefined);
});
