# Shelly Dump Load Controllers

JavaScript scripts for Shelly devices that switch dump loads and heating relays on an
off-grid Victron system at Muttonhall.

## System Architecture

The Victron Cerbo GX is the MQTT broker and the source of every energy reading. Each Shelly
runs one script, reads the Cerbo and the other Shellys over MQTT, and switches its own loads.

### Documentation

This file describes each script and how it is deployed. The reasons are elsewhere:

| Document | Covers |
|---|---|
| [POWER.md](POWER.md) | The electrical installation: generation, battery, inverters, generator settings, power flow, the device inventory |
| [HEATING.md](HEATING.md) | The heating plant: heat pump, biomass boiler, buffer, zones, wiring, commissioning |
| [CONTROLS.md](CONTROLS.md) | The system as a whole: shortage, who decides it, what each actuator does, and why |
| [GLOSSARY.md](GLOSSARY.md) | The glossary |
| [docs/adr/](docs/adr) | One decision each: what was chosen, what was rejected, and what that cost |
| [docs/](docs) | The archive: incident write-ups and equipment manuals |

## Quick Start / Deployment

### Automated Deployment

```bash
pip3 install -r requirements.txt
cp deploy.conf.example deploy.conf   # then edit the device IPs
./deploy.py                          # every device in deploy.conf
./deploy.py --device 192.168.1.100   # one device
```

`deploy.conf`, one line per deployment:
```
DEVICE_IP:SCRIPT_ID:SCRIPT_FILE:SCRIPT_NAME
192.168.1.100:1:soc-relay-controller.js:Dump Load
```

`deploy.py` creates the script if it does not exist, uploads it in chunks (scripts over
1024 bytes), and stops and restarts it.

### Manual Installation

In the device web interface, create a script under Scripts, paste the file, check its
`config`, then enable and start it.

## Tests

```bash
node --test tests/
```

No dependencies and no build step. `tests/harness.js` loads a controller under stubbed
`Shelly`, `MQTT`, `Timer` and `Virtual` globals and exports its internals. `Shelly.call`
records its callback and never calls it, so `init()` stops after the first RPC and a test
answers RPCs as the device would. One suite per script.

## Scripts Overview

### soc-relay-controller.js

**Device:** Shelly Plus 1PM Gen3 (DHW immersions), Shelly 1 Mini Gen3 (Heat Pump Enable)
**Purpose:** Switch a DHW immersion on its SOC band; on .209, decide shortage and show it on
the heat pump lock

**What it does.** Two roles, resolved from the device ID at startup: dump load on the DHW
immersions (.88 .90 .91 .100), and shortage lead on .209, whose relay is the heat pump lock
([CONTROLS](CONTROLS.md#who-decides-and-how-the-decision-travels)). One ladder, first match
wins:

| | Rung | On a dump load | On .209 |
|---|---|---|---|
| 0 | Inverter overload | Off above `inverter.emergencyLimit` (13 kW), on the MQTT message and on every poll | Dropped |
| 1 | Shortage | Off while the lock is open. A lock never heard from sheds nothing | Relay open in shortage, closed otherwise |
| 2 | Local input | On, after the headroom check | Dropped |
| 3 | Lead relay input | Follows the time switch on .90, after the headroom check | Dropped |
| 4 | VE.Bus state | On only in Inverting (9). No reading within `startupGrace` (5 min) does nothing; after that it counts as not inverting | Part of rung 1 |
| 5 | SOC band | On at `high` with the generation gate and headroom check; off at `low` | No band |

- **VE.Bus state** also covers the AC inputs: a generator on either takes VE.Bus out of 9.
- **Shortage** (.209 only): `config.shortage` (30% / 90%), VE.Bus state and
  `minGenerationPower`, per [CONTROLS.md](CONTROLS.md#shortage). The latch starts
  unresolved.
- **Generation gate:** no enable below `minGenerationPower` (500 W) of AC- plus DC-coupled
  generation. On .209 the same figure resolves an unresolved latch.
- **Headroom check:** inverter output plus `inverter.heaterPower` (2700 W) under
  `inverter.emergencyLimit`. No dwell timers. Polls every 30 s.
- **Stagger:** when the lock closes or the time switch turns on, a relay waits its
  `pollOffset` (0, 10 or 20 s by tank) before enabling. Shedding never waits. See
  [CONTROLS.md](CONTROLS.md#dump-loads-together).

**What it reads.** Five Victron paths — `system/0/Dc/Battery/Soc`,
`system/0/Ac/PvOnOutput/L1/Power`, `dcsource/279/Dc/0/Power`, `vebus/276/State`,
`vebus/276/Ac/Out/L1/P` — plus the lead relay's `input:0` and .209's `switch:0` status.
Subscriptions: seven on .88, .91 and .100; six on .90, which reads its own input locally;
five on .209.

**What it requires.** A row in `config.relays` matching the device ID, read with
`Shelly.getDeviceInfo()` before anything else runs; an unlisted device runs nothing.
`detached` / `initial_state: "off"` on .88 .91 .100, `follow` / `match_input` on .90,
`detached` / `initial_state: "on"` on .209 ([relay configuration](CONTROLS.md#relay-configuration)).
`status_ntf`, which the script turns on (rebooting) if off.

**Configuration.** `config.relays`: one row per device with its `name`, `high` threshold
(`low` defaults to `high - 1`), `pollOffset`, and the `leadRelay` / `shortageLead` flags.
`config.shortage` holds .209's thresholds. No threshold is exposed on the device; a
`number:202` on the device is not read.

**Virtual components.** `text:204`, the status line. On .209 it shows the shortage term
(`SHORTAGE: SOC 28%`) and `config.shortage` as the band, `[On:90%, Off:30%]`.

### surplus-dump-controller.js

**Device:** Shelly Pro 0/1-10V Dimmer PM
**Purpose:** Allocate surplus generation across four 2.69 kW buffer immersions, one of them
variable

**What it does.** Four stages, allocated in list order. Each remote stage names its device
and channel:

| Stage | Output | Load |
|---|---|---|
| 1 | Shelly Pro 2PM (.161) switch 0, over MQTT RPC | Buffer immersion 1 |
| 2 | Shelly Pro 2PM (.161) switch 1, over MQTT RPC | Buffer immersion 2 |
| 3 | Shelly Pro 1PM (.65) switch 0, over MQTT RPC | Buffer immersion 4 |
| 4 | Local 0–10 V dimmer output, 0–100% | Buffer immersion 3 |

```
Available = Solar + DC Hydro - AC Consumption + Intended Dumps - EV Headroom - Battery Headroom
```

Dump power is the intended figure, not the measured one, except in dry-run mode.

Priority, first match wins:

1. **Initialisation** — wait for every remote stage's status, up to `statusSeedTimeout`
   (90 s), then treat silent stages as off. Loads found running are adopted, not shed.
2. **VE.Bus state** — all off unless Inverting (9), or unheard
3. **Low SOC** — all off below `soc.targetSOC` (97%)
4. **EV charging in auto** — surplus control
5. **High SOC** — above target, dump up to the inverter limit
6. **Surplus control** — sequential allocation

- **Inverter limit:** dumps are capped so that AC consumption minus AC-coupled generation
  stays within `dumpLoad.maxInverterContribution` (12 kW). Inverter output over
  `dumpLoad.emergencyInverterLimit` (13 kW) sheds every stage on the MQTT message. Power flow
  is in [POWER.md](POWER.md).
- **Headroom:** while the EVSE charges in auto, 460 W (2 A at 230 V), or `evse.maxHeadroom`
  (7360 W) minus charger power if less; otherwise `dumpLoad.batteryHeadroom` (200 W).
- **Stall:** a stage on, at 200 V or more and 50 W or less, has reached its thermal cutout. It
  stays on and its budget goes to the next stage. Not checked for 30 s after a change.
- **Minimum change time:** `dumpLoad.minChangeTime` (10 min) per stage, both directions.
  Available power below `dumpLoad.minSurplus` (100 W) sheds every stage regardless. See
  [CONTROLS.md](CONTROLS.md#dump-loads-together).
- **Dimmer:** rounded down, changed only by `dumpLoad.minChangePercent` (2%) or more.
- Polls every 5 s. A stage already in position is not commanded.

**What it reads.** Seven Victron subscriptions — `system/0/Ac/PvOnOutput/L1/Power`,
`dcsource/279/Dc/0/Power`, `system/0/Ac/ConsumptionOnOutput/L1/Power`, `evcharger/40/#`,
`system/0/Dc/Battery/Soc`, `vebus/276/State`, `vebus/276/Ac/Out/L1/P` — plus one
`<device-id>/status/+` per remote device: nine in all.

**What it requires.** Remote stages `detached` with `initial_state: "off"`
([relay configuration](CONTROLS.md#relay-configuration)). `status_ntf` on this device, which
the script asserts, and on each remote device.

**Configuration.** `remoteSwitches.switches`, one entry per remote stage;
`dumpLoad.heaterPower` (2690 W); `dryRun`; `soc.targetSOC`; `evse.maxHeadroom`.

**Virtual components.** `text:200`, the status line.

### thermal-dump-controller.js

**Device:** Shelly 2PM Gen3 (.156)
**Purpose:** Recover the heat in a buffer immersion that has reached its thermal cutout

**What it does.** Switch 0 is the garage fan coil, switch 1 the buffer circulation pump.
Priority, first match wins:

1. **Frost protection** — both on while the frost thermostat on `input:0` is active
2. **Boiler** — both off while the boiler is operating, its state is unheard, or the Fröling
   bridge is down
3. **Temperature** — both off below `thresholds.minTankTemp` (70 °C) at the buffer top, or
   while the bridge is down
4. **Thermal dump** — if any monitored immersion is stalled: pump on; fan coil on while top
   minus bottom is within `thresholds.maxTempDelta` (5 °C)

- **Stall:** output on, at least `thresholds.minVoltage` (200 V), at most
  `thresholds.maxConsumption` (5 W).
- **Minimum run time:** 5 min before an output this run started is turned off.
- **Bridge down** is `temperature/100/Connected` at 0. See
  [CONTROLS.md](CONTROLS.md#when-the-fröling-bridge-falls-over).

**What it reads.** `temperature/100/Temperature` and `temperature/101/Temperature` (buffer top
and bottom), `digitalinput/102/State` (boiler), `temperature/100/Connected`, and the status of
each monitored immersion — the Pro 2PM's `switch:0` and `switch:1`, the dimmer's `light:0`,
the Pro 1PM's `switch:0` (buffer immersions 1–4): eight subscriptions.

**What it requires.** The frost thermostat on `input:0`. `status_ntf` on this device, which
the script asserts, and on each monitored device. `config.dumpLoads` kept in step with the
stages of `surplus-dump-controller.js`.

**Configuration.** `config.dumpLoads`; `config.thresholds`; `minRunTime` (5 min);
`checkInterval` (10 s, the poll).

**Virtual components.** `text:200`, the status line.

### heating-relay-controller.js

**Device:** Shelly 1 Mini Gen3 (Boiler Release, .164)
**Purpose:** Close the Fröling's volt-free release contact. A release is permission, not a
command to burn — see [GLOSSARY.md](GLOSSARY.md)

**What it does.** One ladder, first match wins:

| | Rung | Reads | Releases |
|---|---|---|---|
| 1 | H1, the Grant's back-up heater request | its own `input:0` | at once; hardware `follow` has already closed the relay |
| 2 | DHW demand | .123's `input:0` (the DHW time clock) | at once |
| 3 | Shortage | .209's switch status | once the lock has been open `release.sustainedAfter` (30 min) |
| 4 | Exercise run | the clock, `digitalinput/102/State` | every other Sunday at 11:00 local, unless an ignition was seen in the last 14 days |

- A release this script makes lasts at least `release.minimumOnTime` (60 min). A relay found
  closed at startup is left alone until the lock and the DHW clock have been heard, or for
  `startupGrace` (5 min).
- An ignition is a stopped-to-running edge on the boiler input, held in RAM only.
- The exercise day is UTC days since the epoch modulo 14 equal to 3; the hour is local.
- The lock and its open timer survive a broker drop; the DHW clock and boiler state do not.
- Polls every 30 s. See [CONTROLS](CONTROLS.md#shedding-is-not-the-same-as-making-heat) and
  [the exercise run](CONTROLS.md#exercise-run).

**What it reads.** Three subscriptions: .209's `switch:0` status, .123's `input:0` and
`digitalinput/102/State`. Its own `input:0` it reads locally.

**What it requires.** The device ID in `config.device`; anywhere else it does nothing.
`follow` with `initial_state: "match_input"` ([relay configuration](CONTROLS.md#relay-configuration)).
`status_ntf`, which the script turns on (rebooting) if off. A synchronised clock, for the
exercise run only.

**Configuration.** `config.release` (the 30 min, the 60 min, the exercise slot),
`config.heatPumpLock`, `config.dhwClock`, `config.device`.

**Virtual components.** `text:200`, the status line: relay, lock (with how long it has been
open), boiler, DHW clock, H1, time since the last ignition, and the release reason.

### dhw-controller.js

**Device:** Shelly 1 Mini Gen3 (DHW Enable, .123)
**Purpose:** Permit heat to move from the buffer into the three cylinders. The enable is not
DHW demand: .164 reads this device's input, never its relay

**What it does.** Two rungs, first match wins:

| | Rung | Reads | Guarded by |
|---|---|---|---|
| 1 | The DHW time clock | its own `input:0` | nothing |
| 2 | A shortage DHW window | .209's switch status, and the local clock | buffer top or boiler flow at or above `window.minBufferTemp` (60 °C) |

The rules are in [CONTROLS.md](CONTROLS.md#dhw).

- **Slots:** `window.slotHours` (05, 11, 17, 23) against the first two characters of
  `sys.time`; none without a synchronised clock. The lock opening starts an entry window of
  `window.entryWindowLength` (1 hour), which needs no clock.
- **Guard:** the higher of buffer top (`temperature/100`) and boiler flow (`temperature/103`);
  a reading that has not arrived is left out, not read as cold.
- **Unguarded:** with `temperature/100/Connected` at 0, or no reading for `startupGrace`
  (5 min) after the last connect, a window runs without the guard. The status line shows
  `(blind)`.
- **Latch:** once the guard passes, the enable stays closed to the end of the window, and
  across two windows that touch. The latch is set in the poll that commands the relay.
- **Restart:** nothing is stored. A relay found closed is left alone while the lock or a
  temperature is outstanding, up to `startupGrace`. A restart during shortage opens an entry
  window. Polls every 30 s.

**What it reads.** Four subscriptions: .209's `switch:0` status,
`temperature/100/Temperature`, `temperature/103/Temperature` and `temperature/100/Connected`.
Its own `input:0` it reads locally.

**What it requires.** The device ID in `config.device`; an unrecognised device runs nothing
and leaves the time clock passing through in hardware. `follow` with
`initial_state: "match_input"` ([relay configuration](CONTROLS.md#relay-configuration)).
`status_ntf`, which the script turns on (rebooting) if off; .164 reads this device's
`input:0`. A synchronised clock, for the scheduled slots.

**Configuration.** `config.window` (slots, entry window length, temperature guard);
`config.heatPumpLock`; `config.device`.

**Virtual components.** `text:200`, the status line: relay, lock, buffer top, boiler flow,
time clock, window (`held` / `waiting`) and the enable reason.

## Common Patterns

### Re-entrancy Prevention
Controllers track intended and actual relay state, so an RPC callback and a status event for
the same change do not both act.

### MQTT Keepalive
The Cerbo publishes only on change. Each script sends an empty-payload keepalive 1 s after
subscribing (`MQTT.subscribe` takes effect only once the script returns to the main loop),
then every 30 s with `suppress-republish` — or a full republish again while a reading it
needs has not arrived: `vebus/276/State` (soc-relay, surplus-dump), the boiler input
(heating-relay, thermal-dump), `/Connected` (thermal-dump, dhw), the temperatures (dhw).

### Virtual Components
One text component per script, for its status line. No settings are exposed.

### Event-Driven Architecture
Local changes arrive through `Shelly.addEventHandler()` (`Shelly.addStatusHandler()` in
`surplus-dump-controller.js`); each script also polls.

### MQTT Subscription Budget
A script may hold **ten** MQTT subscriptions. The eleventh throws `Too many subscriptions` and
the script does not run at all, taking every load that controller owns with it. Count before
adding a topic.

Two ways to stay under it, both used by `surplus-dump-controller.js`:
- **Subscribe to a subtree** — `evcharger/40/#` is one subscription instead of three;
  messages are still matched against exact paths.
- **One wildcard per device** — `<device-id>/status/+` covers every channel on that device.

### Seeding State From Other Devices
Shelly publishes status on change and does not retain it. A PM channel republishes every
20–30 s as its readings drift; an input or unmetered switch is a silent signal. So a follower
publishes `status_update` to the device's `<prefix>/command` topic, which republishes every
component on `<prefix>/status/…` (needs only `enable_control`, on by default). It asks 1 s
after subscribing and on each 30 s keepalive until answered:

| Script | Asks |
|---|---|
| `soc-relay-controller.js` | .90 for the time switch (from .88 .91 .100), .209 for the lock (from every immersion); .209 asks nobody |
| `surplus-dump-controller.js` | each remote device with an unreported stage, once per device |
| `heating-relay-controller.js` | .209 for the lock, .123 for the DHW time clock |
| `dhw-controller.js` | .209 for the lock |

What a broker drop does to a followed reading is in
[CONTROLS.md](CONTROLS.md#who-decides-and-how-the-decision-travels).

## Configuration

Each script has a `config` object at the top, and its thresholds live there and nowhere
else:

```javascript
cerbo: { host: "192.168.1.71", port: 1883, portalId: "c0847dc9a794" },
```

The portal ID is on the Cerbo under Settings → Services → VRM Portal.

## Debugging

`debugMode: true` in `config` (the default) logs to the Shelly console with a prefix per
script: `[DEBUG-DUMP]` soc-relay, `[DEBUG-SURPLUS]` surplus-dump, `[DEBUG-THERMAL]`
thermal-dump, `[DEBUG-HEAT]` heating-relay, `[DEBUG-DHW]` dhw.

### Quick Status Check

```bash
# soc-relay-controller (text:204)
wget -qO- http://<device>/rpc/Text.GetStatus?id=204

# surplus-dump, thermal-dump, heating-relay, dhw (text:200)
wget -qO- http://<device>/rpc/Text.GetStatus?id=200
```

Device addresses are in [POWER.md](POWER.md). Example output:
```
{"value":"97% [On:96%, Off:95%], DHW Left Top ON, Gen 8530W, Inv 414W, VE Inverting, Input OFF, Lead OFF, HP Enabled: Monitoring","source":"sys","last_update_ts":1771542699}
```

## License

MIT License. See [LICENSE](LICENSE) for details.

## Safety Notes

- Dump loads generate significant heat; ensure proper thermal management
- Have the electrical installation verified by a qualified electrician
- Run `surplus-dump-controller.js` with `dryRun: true` before letting it switch loads
- Monitor the system for the first 24–48 hours after a change
- Ensure proper circuit protection (breakers, fuses)
