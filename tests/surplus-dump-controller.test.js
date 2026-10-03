// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 Robert McQueen
//
// Tests for surplus-dump-controller.js. Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const { load, captureLog, advanceClock, withJumpedWallClock } =
  require("./harness.js");

const SCRIPT = "surplus-dump-controller.js";
const HEATER = 2690; // W, nominal per immersion
const PRO2PM = "shellypro2pm-ec6260a03d70"; // immersions 1 and 2
const PRO1PM = "shellypro1pm-5c013b056870"; // immersion 4

function loadController() {
  return load(SCRIPT);
}

// The on/off value of every Switch.Set this controller published, in order.
function switchCommands(published) {
  return published
    .filter((p) => p.topic.endsWith("/rpc"))
    .map((p) => JSON.parse(p.payload).params.on);
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

// ===== The emergency inverter limit =====
// Sheds on the MQTT message, not the next poll.

// A controller past initialisation with every stage running.
function dumping(mod) {
  mod.state.mqttConnected = true;
  mod.state.initialized = true;
  mod.state.remoteSwitches.forEach((s) => {
    s.on = true;
    s.statusReceived = true;
    s.voltage = 230;
    s.power = HEATER;
  });
}

test("an inverter over the emergency limit sheds every stage on the message", () => {
  const { mod, published } = loadController();
  dumping(mod);

  victron(mod, "inverterOutput", 13500);

  assert.deepStrictEqual(switchCommands(published), [false, false, false],
    "the shed must not wait for the next poll: five seconds is 40 kJ of overload");
});

test("the limit is the figure the incident passed, not a round number above it", () => {
  const { mod, published } = loadController();
  dumping(mod);

  victron(mod, "inverterOutput", 13000);
  assert.deepStrictEqual(switchCommands(published), [],
    "at the limit exactly, nothing sheds");

  victron(mod, "inverterOutput", 13009); // just over the limit
  assert.deepStrictEqual(switchCommands(published), [false, false, false]);
});

test("a stage already off is not commanded off again", () => {
  const { mod, published } = loadController();
  dumping(mod);
  mod.state.remoteSwitches[1].on = false;

  victron(mod, "inverterOutput", 13500);

  assert.strictEqual(switchCommands(published).length, 2,
    "the shed is a desired state, not a broadcast");
});

test("an overload does not wait for initialisation", () => {
  const { mod, published } = loadController();
  mod.state.mqttConnected = true;
  // Two stages reported on, the third not yet
  mod.state.remoteSwitches[0].on = true;
  mod.state.remoteSwitches[0].statusReceived = true;
  mod.state.remoteSwitches[1].on = true;
  mod.state.remoteSwitches[1].statusReceived = true;

  victron(mod, "inverterOutput", 14000);

  assert.strictEqual(mod.state.initialized, false, "still seeding");
  assert.deepStrictEqual(switchCommands(published), [false, false],
    "the seeding wait is there to stop an uninformed controller enabling; holding " +
    "5.4 kW on an overloaded inverter for up to statusSeedTimeout is not what it is for");
});

test("a stage that has not reported is not commanded even in an emergency", () => {
  const { mod, published } = loadController();
  mod.state.mqttConnected = true;

  victron(mod, "inverterOutput", 14000);

  assert.deepStrictEqual(switchCommands(published), [],
    "a stage this controller has never heard from is one it cannot shed, and " +
    "guessing at its position is not shedding it");
});

// ===== The 12 kW inverter contribution limit =====
// Dumps are budgeted against baseLoad = acConsumption - dumpPower.

test("the dumps' own draw is not counted against the limit", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 9000;   // 3620 W of house, 5380 W of it the dumps
  mod.state.intendedDumpPower = 2 * HEATER;
  mod.state.solarPower = 0;

  assert.strictEqual(mod.calculateMaxDumpPower(false), 12000 - 3620,
    "budgeting against its own output is a controller that switches itself off");
});

test("high SOC does not dump on top of a loaded inverter", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 7000;   // house load, dumps not yet on
  mod.state.solarPower = 0;
  mod.state.intendedDumpPower = 0;

  const max = mod.calculateMaxDumpPower(false);
  assert.strictEqual(max, 5000);
  assert.deepStrictEqual(mod.calculateDesiredState(max).switches, [true, false, false],
    "5 kW of headroom is one immersion and a dimmer, not three immersions");
});

test("a base load already over the limit turns every stage off", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 13000;
  mod.state.solarPower = 0;
  mod.state.intendedDumpPower = 0;

  const max = mod.calculateMaxDumpPower(false);
  assert.ok(max < 0, "negative capacity is the case this has to survive, not reject");
  assert.deepStrictEqual(mod.calculateDesiredState(max).switches, [false, false, false]);
});

test("AC-coupled generation does not count against the inverter", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 7000;
  mod.state.solarPower = 7000;      // the house is carried by the roof, not the battery
  mod.state.intendedDumpPower = 0;

  assert.strictEqual(mod.calculateMaxDumpPower(false), 12000);
  assert.deepStrictEqual(mod.calculateDesiredState(12000).switches, [true, true, true]);
});

test("DC-coupled hydro does count, because it reaches the house through the inverter", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 7000;
  mod.state.solarPower = 0;
  mod.state.intendedDumpPower = 0;

  const withoutHydro = mod.calculateMaxDumpPower(false);
  mod.state.dcHydroPower = 3000;

  // DC hydro is generation for surplus but passes through the inverter
  assert.strictEqual(mod.calculateMaxDumpPower(false), withoutHydro);
  assert.strictEqual(mod.calculateAvailablePower(false),
    3000 - 7000 - mod.config.dumpLoad.batteryHeadroom);
});

test("the actual draw is read when observing, the intended when controlling", () => {
  const { mod } = loadController();
  mod.state.acConsumption = 9000;
  mod.state.solarPower = 0;
  mod.state.remoteSwitches[0].power = 2700;  // what the meter says
  mod.state.intendedDumpPower = 0;           // what this controller asked for

  assert.strictEqual(mod.calculateMaxDumpPower(true), 12000 - (9000 - 2700));
  assert.strictEqual(mod.calculateMaxDumpPower(false), 12000 - 9000,
    "controlling on the measurement is what closes the feedback loop");
});

// ===== The two headroom reserves =====
// 200 W battery reserve, or 2 A of EVSE headroom instead when it charges in auto.

test("battery headroom is held back from the surplus", () => {
  const { mod } = loadController();
  mod.state.solarPower = 1000;

  assert.strictEqual(mod.calculateAvailablePower(false),
    1000 - mod.config.dumpLoad.batteryHeadroom);
});

test("an EV charging in auto is left its next step, and the battery reserve drops", () => {
  const { mod } = loadController();
  mod.state.solarPower = 5000;
  mod.state.evChargerMode = 1;      // Auto
  mod.state.evChargerStatus = 2;    // Charging
  mod.state.evChargerPower = 7000;  // 360 W short of its ceiling

  assert.strictEqual(mod.isEvChargingInAuto(), true);
  assert.strictEqual(mod.calculateAvailablePower(false), 5000 - 360,
    "the reserve is what the charger can still take, and the battery's 200 W is not " +
    "also held back");
});

test("a charger with room to step up reserves the full 2 A margin", () => {
  const { mod } = loadController();
  mod.state.solarPower = 5000;
  mod.state.evChargerMode = 1;
  mod.state.evChargerStatus = 2;
  mod.state.evChargerPower = 0;

  assert.strictEqual(mod.calculateAvailablePower(false), 5000 - 460,
    "460 W is one 2 A step at 230 V, not the charger's whole 7360 W ceiling");
});

test("connected is not charging, and manual is not auto", () => {
  const { mod } = loadController();
  mod.state.solarPower = 1000;

  mod.state.evChargerMode = 1;
  mod.state.evChargerStatus = 1;    // plugged in, not drawing
  assert.strictEqual(mod.isEvChargingInAuto(), false);

  mod.state.evChargerStatus = 2;
  mod.state.evChargerMode = 0;      // Manual: it is not bidding for surplus
  assert.strictEqual(mod.isEvChargingInAuto(), false);

  assert.strictEqual(mod.calculateAvailablePower(false),
    1000 - mod.config.dumpLoad.batteryHeadroom,
    "neither case yields the reserve to the charger");
});

// ===== The priority ladder =====

test("an inverter that is not inverting suppresses every stage", () => {
  const { mod, published } = loadController();
  dumping(mod);
  victron(mod, "vebusState", 0);    // heard, and it says Off
  mod.state.batterySOC = 99;

  const log = captureLog(() => mod.checkSystemState());

  assert.deepStrictEqual(switchCommands(published), [false, false, false]);
  assert.ok(log.indexOf("VE Off") !== -1, log);
});

test("an unheard VE.Bus state suppresses exactly as Off does", () => {
  const { mod, published } = loadController();
  dumping(mod);
  mod.state.batterySOC = 99;        // vebusReceived is still false

  mod.checkSystemState();

  assert.deepStrictEqual(switchCommands(published), [false, false, false],
    "a full battery is no reason to dump onto an inverter nobody has heard from");
});

test("SOC below target suppresses, whatever the surplus", () => {
  const { mod, published } = loadController();
  dumping(mod);
  mod.state.vebusState = INVERTING;
  mod.state.batterySOC = 90;
  mod.state.solarPower = 10000;

  const log = captureLog(() => mod.checkSystemState());

  assert.deepStrictEqual(switchCommands(published), [false, false, false]);
  assert.ok(log.indexOf("Low SOC") !== -1, log);
});

test("an EV charging in auto takes surplus control, not the maximum dump", () => {
  const { mod } = loadController();
  dumping(mod);
  mod.state.vebusState = INVERTING;
  mod.state.batterySOC = 99;        // high enough for the max-dump branch
  mod.state.evChargerMode = 1;
  mod.state.evChargerStatus = 2;

  const log = captureLog(() => mod.checkSystemState());

  assert.ok(log.indexOf("EV auto mode") !== -1,
    "max dumps would make the EVSE back off, and the two would trade the surplus " +
    "back and forth: " + log);
});

test("above target it dumps to the inverter limit, at target it tracks surplus", () => {
  const above = loadController();
  dumping(above.mod);
  above.mod.state.vebusState = INVERTING;
  above.mod.state.batterySOC = 98;
  assert.ok(captureLog(() => above.mod.checkSystemState())
    .indexOf("High SOC - Max dump") !== -1);

  const at = loadController();
  dumping(at.mod);
  at.mod.state.vebusState = INVERTING;
  at.mod.state.batterySOC = 97;     // the target itself is neither branch
  assert.ok(captureLog(() => at.mod.checkSystemState()).indexOf("Monitoring") !== -1);
});

test("an SOC never heard from tracks surplus rather than suppressing", () => {
  const { mod } = loadController();
  dumping(mod);
  mod.state.vebusState = INVERTING;  // batterySOC is still its initial 0

  const log = captureLog(() => mod.checkSystemState());

  // SOC 0 means not yet received, and is ignored
  assert.ok(log.indexOf("Monitoring") !== -1, log);
});

// ===== The minimum change time, and what outranks it =====
// Allocation order: stalled, then locked, then free.

// A lastChangeUptime ms ago
function changedAgo(mod, ms) {
  return mod.state.nowUptime - ms;
}

test("a stage never commanded is not locked", () => {
  const { mod } = loadController();
  assert.strictEqual(mod.isLoadLocked(null), false,
    "a fresh script has moved nothing, so nothing is waiting out a lock");
});

test("the lock ends at ten minutes", () => {
  const { mod } = loadController();
  const window = mod.config.dumpLoad.minChangeTime;

  assert.strictEqual(mod.isLoadLocked(changedAgo(mod, window - 1000)), true);
  assert.strictEqual(mod.isLoadLocked(changedAgo(mod, window)), false);
});

test("a locked ON stage rides out a surplus that has fallen below it", () => {
  const { mod } = loadController();
  mod.state.remoteSwitches[0].on = true;
  mod.state.remoteSwitches[0].lastChangeUptime = changedAgo(mod, 60 * 1000);

  assert.deepStrictEqual(mod.calculateDesiredState(200).switches, [true, false, false]);
});

test("a locked OFF stage stays off however much surplus arrives", () => {
  const { mod } = loadController();
  mod.state.remoteSwitches[1].on = false;
  mod.state.remoteSwitches[1].lastChangeUptime = changedAgo(mod, 60 * 1000);

  assert.deepStrictEqual(mod.calculateDesiredState(3 * HEATER).switches,
    [true, false, true]);
});

test("a surplus below the floor sheds a locked stage anyway", () => {
  const { mod } = loadController();
  mod.state.remoteSwitches[0].on = true;
  mod.state.remoteSwitches[0].lastChangeUptime = changedAgo(mod, 60 * 1000);

  // minSurplus is checked before the lock
  assert.deepStrictEqual(mod.calculateDesiredState(50).switches, [false, false, false]);
});

test("a locked ON stage consumes its nominal power, so the next stage is not given it twice", () => {
  const { mod } = loadController();
  mod.state.remoteSwitches[0].on = true;
  mod.state.remoteSwitches[0].lastChangeUptime = changedAgo(mod, 60 * 1000);

  const desired = mod.calculateDesiredState(2 * HEATER);

  assert.deepStrictEqual(desired.switches, [true, true, false],
    "two heaters of surplus is two stages, whichever of them is locked");
  assert.strictEqual(desired.intendedPower, 2 * HEATER);
});

test("a locked OFF stage skips its allocation, so the next stage gets the power", () => {
  const { mod } = loadController();
  mod.state.remoteSwitches[0].on = false;
  mod.state.remoteSwitches[0].lastChangeUptime = changedAgo(mod, 60 * 1000);

  assert.deepStrictEqual(mod.calculateDesiredState(HEATER + 50).switches,
    [false, true, false],
    "the surplus goes somewhere rather than being held against a stage that cannot take it");
});

test("a stalled stage stays on and consumes no budget", () => {
  const { mod } = loadController();
  const stage = mod.state.remoteSwitches[0];
  stage.on = true;
  stage.voltage = 230;   // energised
  stage.power = 0;       // and drawing nothing: the cylinder stat has opened

  const desired = mod.calculateDesiredState(2 * HEATER);

  assert.deepStrictEqual(desired.switches, [true, true, true],
    "a cut-out stage keeps its contactor closed so it recovers, and its 2.69 kW " +
    "goes to a stage that can use it");
  assert.strictEqual(desired.intendedPower, 2 * HEATER);
});

test("stalled outranks locked, rather than the lock reserving power for a cut-out stage", () => {
  const { mod } = loadController();
  const stage = mod.state.remoteSwitches[0];
  stage.on = true;
  stage.voltage = 230;
  stage.power = 0;
  stage.lastChangeUptime = changedAgo(mod, 60 * 1000);  // locked as well as stalled

  assert.deepStrictEqual(mod.calculateDesiredState(2 * HEATER).switches,
    [true, true, true],
    "reading the lock first charges 2.69 kW to a stage drawing nothing");
});

test("a stage that has just changed is not read as stalled", () => {
  const { mod } = loadController();
  const stage = mod.state.remoteSwitches[0];
  stage.on = true;
  stage.voltage = 230;
  stage.power = 0;                          // the meter has not caught up yet
  stage.lastChangeUptime = changedAgo(mod, 10 * 1000);

  // Within the grace period, so not stalled
  assert.deepStrictEqual(mod.calculateDesiredState(2 * HEATER).switches,
    [true, true, false]);
  assert.strictEqual(mod.calculateDesiredState(2 * HEATER).intendedPower, 2 * HEATER);
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

  advanceClock(mod.config.statusSeedTimeout + 1000);
  mod.checkSystemState();

  assert.strictEqual(mod.state.initialized, true,
    "must control once the bounded wait expires");
});

// A restart seeds intendedDumpPower from the stages' reported draw.

// Every stage reporting on at nominal power
function stagesRunning(mod) {
  mod.config.remoteSwitches.switches.forEach((sw) => {
    mod.processMqttMessage(sw.deviceId + "/status/switch:" + sw.switchId,
      JSON.stringify({ output: true, apower: HEATER, voltage: 230 }));
  });
}

test("a restart adopts the loads it found running rather than shedding them", () => {
  const { mod, published } = loadController();
  mod.state.mqttConnected = true;
  mod.state.vebusState = INVERTING;
  mod.state.batterySOC = 98;        // above target, so the high-SOC branch runs
  mod.state.acConsumption = 3 * HEATER;  // the stages are the whole of the load
  stagesRunning(mod);

  mod.checkSystemState();

  assert.strictEqual(mod.state.initialized, true);
  assert.deepStrictEqual(switchCommands(published), [],
    "the first pass after a restart must command nothing it does not have a reason for");
});

// The control pass overwrites intendedDumpPower, so assert on the console line
test("the seed is what the stages report drawing, not what the table says they draw", () => {
  const { mod } = loadController();
  mod.state.mqttConnected = true;
  mod.state.vebusState = INVERTING;
  mod.state.batterySOC = 98;
  mod.config.remoteSwitches.switches.forEach((sw, i) => {
    mod.processMqttMessage(sw.deviceId + "/status/switch:" + sw.switchId,
      JSON.stringify({ output: i < 2, apower: i < 2 ? 2710 : 0, voltage: 230 }));
  });

  const log = captureLog(() => mod.checkSystemState());

  assert.ok(log.indexOf("Initialized intended dump power to actual: 5420W") !== -1,
    "two stages at 2710 W measured, not two at the 2690 W nominal: " + log);
});

test("a restart that finds nothing running seeds nothing", () => {
  const { mod } = loadController();
  mod.state.mqttConnected = true;
  mod.state.vebusState = INVERTING;
  mod.state.batterySOC = 50;
  mod.config.remoteSwitches.switches.forEach((sw) => {
    mod.processMqttMessage(sw.deviceId + "/status/switch:" + sw.switchId,
      JSON.stringify({ output: false, apower: 0, voltage: 230 }));
  });

  const log = captureLog(() => mod.checkSystemState());

  assert.strictEqual(mod.state.initialized, true);
  assert.ok(log.indexOf("Initialized intended dump power") === -1,
    "nothing was running, so there is nothing to carry over");
});

test("a broker reconnect re-arms the bounded wait", () => {
  const { mod } = loadController();
  mod.state.firstIncompleteCheckUptime = 12345;

  mod.resetMqttData();

  assert.strictEqual(mod.state.firstIncompleteCheckUptime, null);
  mod.state.remoteSwitches.forEach((s) => {
    assert.strictEqual(s.statusReceived, false);
  });
});

// ===== Seeding the VE.Bus state =====

// Victron publishes only on change, so VE.Bus state arrives only in a republish.
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

// MQTT is already connected when the script starts
function connectedWith(mqttConfig) {
  global.Shelly.getComponentStatus = function () { return { connected: true }; };
  global.Shelly.getComponentConfig = function () { return mqttConfig; };
}

function serverFor(mod) {
  return mod.config.cerbo.host + ":" + mod.config.cerbo.port;
}

// thermal-dump-controller.js watches this device's light:0 status
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

// ===== The clock jumping =====
// Every interval within the run is measured against uptime. See docs/adr/0003.

test("a stage this run never commanded is judged on what it reports", () => {
  // lastChangeUptime null means never commanded, so no grace period
  const { mod } = loadController();
  const stage = mod.state.remoteSwitches[0];
  stage.on = true;
  stage.voltage = 240;
  stage.power = 0;

  assert.strictEqual(stage.lastChangeUptime, null);
  assert.strictEqual(mod.isLoadStalled(stage, stage.lastChangeUptime), true,
    "a thermal cutout went unnoticed for the first thirty seconds of every run");
});

test("NTP landing does not end a stage's settling grace", () => {
  // Through refreshUptime, since isLoadStalled reads no clock itself
  const { mod } = loadController();
  const stage = mod.state.remoteSwitches[0];
  stage.on = true;
  stage.voltage = 240;
  stage.power = 0;
  stage.lastChangeUptime = mod.state.nowUptime;

  withJumpedWallClock(function () {
    mod.refreshUptime();
    assert.strictEqual(mod.isLoadStalled(stage, stage.lastChangeUptime), false,
      "a stage commanded a moment ago was read as stalled, forcing it on");
  });
});
