// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Covers thermal cutout detection across the buffer immersions: every stage the
// surplus controller can switch must be watched here, or it cuts out with nothing
// to recover it. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./harness.js");

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
