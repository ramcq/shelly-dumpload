# Shelly Dump Load Controllers

A collection of JavaScript scripts for Shelly devices that implement various dump load and smart load control strategies for off-grid and grid-tied solar systems with Victron Energy equipment.

## System Architecture

These scripts are designed to work with:
- **Victron Cerbo GX** - Provides MQTT broker and energy system data
- **Shelly devices** - Execute control scripts and switch dump loads
- **MQTT** - Communication between Cerbo GX and Shelly devices

Developed for an off-grid system with Victron Quattro inverters, a Cerbo GX, AC-coupled solar and hydro generation, DC-coupled hydro, and multiple resistive dump loads (immersion heaters). The scripts should be adaptable to other Victron-based systems with similar topology.

### Documentation

This file describes **each script** — what it does, what it reads, what it requires, how it
is configured and how it is deployed. Every reason behind a threshold is somewhere else:

| Document | Covers |
|---|---|
| [POWER.md](POWER.md) | The electrical installation: generation, battery, inverters, generator settings, and the canonical device inventory |
| [HEATING.md](HEATING.md) | The heating plant: heat pump, biomass boiler, buffer, zones, wiring, commissioning |
| [CONTROLS.md](CONTROLS.md) | The system as a whole: shortage, who decides it, what each actuator does, and why |
| [CONTEXT.md](CONTEXT.md) | The glossary: buffer immersion vs DHW immersion, dump load as a mode, shortage, release vs lock, DHW demand vs DHW enable |
| [docs/adr/](docs/adr) | One decision each: what was chosen, what was rejected, and what that cost |
| [docs/](docs) | The archive: incident write-ups and equipment manuals |

Power flow — why AC-coupled generation does not count against the inverter's battery contribution, and how the 12 kW limit is calculated — is in [POWER.md](POWER.md). The overload risk that remains when several controllers act independently is in [CONTROLS.md](CONTROLS.md).

## Quick Start / Deployment

### Automated Deployment (Recommended)

Use the included Python deployment script to upload scripts to multiple devices:

```bash
# Install dependencies
pip3 install -r requirements.txt

# Create deployment configuration
cp deploy.conf.example deploy.conf
# Edit deploy.conf with your device IPs

# Deploy to all devices
./deploy.py

# Or deploy to a single device
./deploy.py --device 192.168.1.100
```

**Configuration file format** (`deploy.conf`):
```
DEVICE_IP:SCRIPT_ID:SCRIPT_FILE:SCRIPT_NAME
192.168.1.100:1:smart-load-controller.js:Smart Load
```

The deployment script:
- Handles chunked uploads for scripts > 1024 bytes
- Creates scripts if they don't exist
- Stops and restarts scripts automatically
- Shows colored status output

### Manual Installation

1. Open Shelly device web interface
2. Navigate to Scripts
3. Create new script
4. Copy/paste appropriate script
5. Configure settings at top of script
6. Enable and start script

## Tests

```bash
node --test tests/
```

No dependencies and no build step — `tests/harness.js` loads a controller under stubbed
`Shelly`, `MQTT`, `Timer` and `Virtual` globals and exports its internals, so the decision
logic can be exercised without a device. `Shelly.call` never calls back, so the script's own
`init()` stalls after the first RPC and starts no timers; it records each callback alongside
its arguments, so a test can answer an RPC as the device would.

The suites go where a failure is expensive on live plant rather than merely wrong:

- which device and channel a stage actually commands
- the [subscription budget](#mqtt-subscription-budget) and
  [initialisation](#seeding-state-from-other-devices), both of which fail by stopping the
  whole controller rather than the stage being changed
- both roles of `soc-relay-controller.js`, which runs from one file: the shortage lead drops
  every dump-load gate, the immersions keep every one of them
- `heating-relay-controller.js`, for the order of its ladder and for the rungs that look
  satisfied and are not — a generator start reaching the rung below, a fourteen-day timer
  read off a clock that has never synchronised, a fire lit on a power system nobody can read
- `dhw-controller.js` from both ends, since its two rungs fail oppositely, with `sys` stubbed
  with and without a synchronised clock

## Scripts Overview

Each section takes the same slots in the same order: device, purpose, what it does, what it
reads, what it requires, configuration, virtual components.

### soc-relay-controller.js

**Device:** Shelly Plus 1PM Gen3 (DHW immersions), Shelly 1 Mini Gen3 (Heat Pump Enable)
**Purpose:** Switch a DHW immersion on a narrow SOC band — or, on .209, hold no band at all
and express shortage on the relay every other controller follows

**What it does.** Two roles, resolved from the device ID at startup:

| Role | Devices | Job |
|---|---|---|
| Dump load | .88 .90 .91 .100 | A DHW immersion on its own SOC band, coordinated by a lead relay carrying the manual time switch, and shed while the heat pump lock is open |
| Shortage lead | .209 | No band of its own: its relay *is* the heat pump lock, and every follower reads it — see [CONTROLS.md](CONTROLS.md) and [ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md) |

One ladder, first match wins. Rung 1 is the whole of what .209 does; every other rung is a
dump load concern, which the shortage lead drops:

| | Rung | On a dump load | On .209 |
|---|---|---|---|
| 0 | Inverter overload | Sheds above `inverter.emergencyLimit`, on MQTT receipt and again on every poll | Dropped |
| 1 | Shortage | Sheds while the lock is open, and returns. A lock never heard from sheds nothing | Its relay is the answer: closed when there is no shortage, open when there is |
| 2 | Local input | Manual override, after a headroom check | Dropped |
| 3 | Lead relay input | Follows the manual time switch on .90, after a headroom check | Dropped |
| 4 | VE.Bus state | Enables only in Inverting (9). Unknown or stale counts as not inverting; nothing received within `config.startupGrace` counts as nothing | A term of shortage, in rung 1 |
| 5 | SOC band | `high` on, `low` off, after the generation gate and a headroom check | No band |

- **Rung 4 is the AC input gate,** under the name of the reading it uses. With no grid on
  site an AC input in use is one generator or another, which takes VE.Bus into Power Assist,
  Bulk, Absorption, Float, Passthru or external control; off, faulted and bypassed are the
  rest of what is not state 9. Why the state is read rather than the generator service is in
  [CONTROLS.md](CONTROLS.md#shortage).
- **Shortage**, computed on .209 only, is `config.shortage`: a latch on SOC with the VE.Bus
  term overlaid rather than gating it, settled by generation where it has never been
  resolved, and nothing heard from the Cerbo means no action either way for
  `config.startupGrace`. The terms and the numbers are in
  [CONTROLS.md](CONTROLS.md#shortage).
- .209 reads its latch back off its own relay contact at startup, trusting it only where the
  switch's last-command `source` shows that something commanded it.
- **Generation gate:** will not enable below `config.minGenerationPower` (500 W) of
  AC-coupled plus DC-coupled generation. On .209 the same threshold settles an unresolved
  shortage latch.
- **Headroom check** before enabling: current inverter output plus `inverter.heaterPower`
  must stay under `inverter.emergencyLimit` (13 kW). Also polled every 30 s.
- **Turn-off is SOC alone and immediate.** There are no dwell timers in either direction, so
  a hydro trip sheds the load at once.
- **On the lock closing or the time switch turning on,** enabling waits
  `config.relays[].pollOffset` (0, 10 or 20 s by tank). Shedding never waits. See
  [CONTROLS.md](CONTROLS.md).

**What it reads.** Five Victron paths — `system/0/Dc/Battery/Soc`,
`system/0/Ac/PvOnOutput/L1/Power`, `dcsource/279/Dc/0/Power`, `vebus/276/State`,
`vebus/276/Ac/Out/L1/P` — plus the lead relay's `input:0` and .209's `switch:0` status: seven
subscriptions on an immersion, five on .209. Its own `input:0` it reads locally.

**What it requires.**
- A row in `config.relays` matched on the ID the device reports at startup, read
  synchronously with `Shelly.getDeviceInfo()` before anything else runs. A device the table
  does not list runs nothing at all.
- `detached` with `initial_state: "off"` on a dump load, `follow` with `match_input` on the
  lead relay (.90), `detached` with `initial_state: "on"` on .209 — the relay configuration
  table is in [CONTROLS.md](CONTROLS.md#relay-configuration).
- `status_ntf` in the device's MQTT config. The script asserts it, rebooting once if it was
  off, since a follower reads a published switch or input status and nothing else.

**Configuration.** `config.relays` is the whole of it: one row per device carrying its name,
its `high` threshold (and `low` where the band is too wide to derive as `high - 1`), and the
`leadRelay` / `shortageLead` flags that are the only things varying by role. No threshold is
exposed on any device — see [CONTROLS.md](CONTROLS.md). A `number:202` left behind by
`smart-load-controller.js` or by an earlier version of this script is ignored, not read.

**Virtual components.** `text:204`, the status display. Its line names the relay and its
position — `HP Enable OFF` — with the term that put it there appended, e.g.
`SHORTAGE: SOC 28%`. On .209 the band it shows is `config.shortage`, `[On:90%, Off:30%]`,
which reads the same way round as a dump load's: the relay closes at the high threshold and
opens at the low one.

---

### surplus-dump-controller.js

**Device:** Shelly Pro 0/1-10V Dimmer PM
**Purpose:** Allocate surplus generation across four 2.69 kW buffer immersions, one of them
variable

**What it does.** Four stages, allocated in list order. Each remote stage names its own
device and channel, so the constant stages need not share a Shelly, and the position in the
list is not the switch id on the device:

| Stage | Output | Load |
|---|---|---|
| 1 | Shelly Pro 2PM switch 0, over MQTT RPC | Buffer immersion 1 |
| 2 | Shelly Pro 2PM switch 1, over MQTT RPC | Buffer immersion 2 |
| 3 | Shelly Pro 1PM switch 0, over MQTT RPC | Buffer immersion 4 |
| 4 | Local 0–10 V dimmer output, variable 0–100% | Buffer immersion 3 |

```
Available = Solar + DC Hydro - AC Consumption + Intended Dumps - EV Headroom
```

Intended dump power rather than measured, which is what keeps the allocation out of a
feedback loop; actual power is used only in dry-run mode.

Priority, first match wins:

1. Wait for initial data, rather than act on stale state
2. **VE.Bus state** — dumps only in Inverting (9)
3. **Low SOC** — suppress below the target (97% default)
4. **EV auto mode** — normal surplus control, so as not to oscillate against the EVSE
5. **High SOC** — enable within the inverter limit, when no EV is charging in auto
6. **Normal surplus control** — sequential allocation

- **Stall detection:** output on, voltage present and no power is a thermal cutout. A stalled
  stage stays on and its budget is reallocated, after a 30-second grace because measurements
  lag commands.
- **Inverter overload:** enforces `dumpLoad.maxInverterContribution` (12 kW) against
  AC consumption minus AC-coupled generation, with a fast-path shutoff at
  `dumpLoad.emergencyInverterLimit` (13 kW). Why DC-coupled generation adds to available
  power without reducing inverter load is in [POWER.md](POWER.md).
- **EVSE coordination:** while the charger is in auto mode, reserves its next step — 2 A at
  230 V, or what the charger can still take if that is less — and holds back no battery
  headroom.
- **`dumpLoad.batteryHeadroom`,** 200 W, kept back for parasitic loads and a trickle charge,
  except while the EVSE is charging in auto.
- **Anti-oscillation:** a `dumpLoad.minChangePercent` (2%) minimum dimmer change, and a floor
  function that biases towards slight underutilisation.
- **`dumpLoad.minChangeTime`,** 10 minutes per stage, both directions, except that available
  power below `dumpLoad.minSurplus` sheds regardless — see
  [CONTROLS.md](CONTROLS.md#dump-loads-together).
- **`statusSeedTimeout`,** 90 seconds: loads already running are not disturbed until every
  stage has reported, and past the bound the silent stages are assumed off and the rest
  controlled anyway. Commanding a stage into the position it is already in is a no-op.

**What it reads.** Seven Victron paths — AC-coupled generation, DC hydro, AC consumption,
`evcharger/40/#`, SOC, VE.Bus state and inverter output — plus one `<device-id>/status/+`
wildcard per remote device: nine subscriptions for three remote stages on two devices.

**What it requires.** Remote stages `detached` with `initial_state: "off"` — see
[CONTROLS.md](CONTROLS.md#relay-configuration). `status_ntf` on this device, which the script
asserts, and on each remote device, whose published switch status is what the allocator
follows.

**Configuration.** `remoteSwitches.switches`, one entry per stage; heater power (2690 W
default); dry-run mode; target SOC threshold; EVSE instance and maximum headroom.

**Virtual components.** `text:200`, the status display, kept minimal to reduce MQTT traffic.

---

### thermal-dump-controller.js

**Device:** Shelly 2PM Gen3
**Purpose:** Recover the heat trapped in a buffer immersion that has reached its thermal
cutout

**What it does.** Priority, first match wins:

1. **Frost protection** — both outputs on, unconditionally, while the frost thermostat is active
2. **Boiler suppression** — off while the boiler is operating, and equally while it has yet
   to hear whether it is
3. **Temperature** — off below `thresholds.minTankTemp` (70 °C) at the buffer top
4. **Thermal dump** — if any monitored immersion is stalled: pump always on, fan coil on where
   top minus bottom is within `thresholds.maxTempDelta` (5 °C)

Stall is output on, voltage at or above 200 V and power at or below 5 W. Intended-state
tracking holds the expected position of each output against the actual one, so only an
unexpected change triggers another pass and RPC callbacks cannot re-enter.

When the Fröling bridge cannot read the boiler — `temperature/100/Connected` at 0 —
priorities 2 and 3 both suppress, on `bridgeIsDown()` rather than on the readings, which are
left where they are because the bridge keeps publishing them. See
[CONTROLS.md](CONTROLS.md#when-the-fröling-bridge-falls-over).

**Controlled outputs:** switch 0 is the garage fan coil, switch 1 the buffer circulation pump.

**What it reads.** `temperature/100/Temperature` and `temperature/101/Temperature` (buffer top
and bottom), `digitalinput/102/State` (the boiler), `temperature/100/Connected` (the bridge
behind the first two), and the switch status of each monitored immersion: eight subscriptions.

Monitored loads are one per buffer immersion, matching the stages `surplus-dump-controller.js`
can switch — an immersion that is switchable but not listed here reaches its thermal cutout
with nothing to recover it:

- Shelly Pro 2PM switch 0 and switch 1 (buffer immersions 1 and 2)
- Shelly Pro Dimmer 0-10V PM light output (buffer immersion 3)
- Shelly Pro 1PM switch 0 (buffer immersion 4)

**What it requires.** The frost thermostat on this device's `input:0`. `status_ntf` on this
device, which the script asserts, and on each monitored device, since a stage that boils with
nothing watching is what an unpublished status costs here.

**Configuration.** `config.dumpLoads`, the monitored list; the stall and temperature
thresholds; a 5-minute minimum run time; a 10-second check interval.

**Virtual components.** `text:200`, the status display.

---

### heating-relay-controller.js

**Device:** Shelly 1 Mini Gen3 (Boiler Release)
**Purpose:** Close the Fröling's volt-free release contact when anything on the site wants
wood burnt. Releasing is permission, never a command — see
[CONTEXT.md](CONTEXT.md) for the term and [CONTROLS.md](CONTROLS.md) for what it costs

**What it does.** One ladder, first match wins:

| | Rung | Reads | Releases |
|---|---|---|---|
| 1 | H1, the Grant's back-up heater request | its own `input:0` | at once; hardware `follow` has already closed the relay |
| 2 | DHW demand | .123's `input:0` (the DHW time clock) | at once |
| 3 | Shortage | .209's switch status | once the lock has been open `release.sustainedAfter` (30 min) |
| 4 | Exercise run | the wall clock, `digitalinput/102/State` | every other Sunday at 11:00, unless an ignition was seen in the last 14 days |

- A release this script makes lasts at least `release.minimumOnTime` (60 min). A relay found
  closed at startup is left alone until the lock and the DHW clock have been heard, or for
  `config.startupGrace` (5 min).
- Ignitions are remembered in RAM only, so a reboot forgets them.
- The lock and its open timer survive a broker drop; the DHW clock and boiler state do not.

**What it reads.** Three subscriptions: .209's `switch:0` status, .123's `input:0` and
`digitalinput/102/State`. Its own `input:0` it reads locally.

**What it requires.**
- The device ID in `config.device`; anywhere else it does nothing.
- `follow` with `initial_state: "match_input"` (see
  [CONTROLS.md](CONTROLS.md#relay-configuration)).
- `status_ntf` in the device's MQTT config, which the script turns on (rebooting) if off.
- A synchronised clock, for the exercise run only.

**Configuration.** `config.release`, `config.heatPumpLock`, `config.dhwClock`, `config.device`.

**Virtual components.** `text:200`, the status display.

---

### dhw-controller.js

**Device:** Shelly 1 Mini Gen3 (DHW Enable)
**Purpose:** Permit heat to move from the buffer into the three cylinders. The enable permits
and never asks, which is why nothing here senses cylinder temperature; it is not DHW demand
and releases no boiler — .164 reads this device's *input* for that rung, never its relay

**What it does.** Two rungs, first match wins:

| | Rung | Reads | Guarded by |
|---|---|---|---|
| 1 | The DHW time clock | its own `input:0` | nothing at all |
| 2 | A shortage DHW window | .209's switch status, and the local wall clock | buffer top or boiler flow at or above `window.minBufferTemp` (60 °C) |

The clock is read first because a `Switch.Set` overrides `follow` until the next input edge.
The window rule — one hour in six, in shortage only, guarded on buffer temperature — and the
reasoning behind both are in [CONTROLS.md](CONTROLS.md#dhw).

- **`config.window.slotHours`** — 05, 11, 17 and 23 — is compared against the first two
  characters of `sys.time` rather than parsed. They are wall-clock times, so a device that has
  never reached an NTP server runs no scheduled slots; `config.window.entryWindowLength` is an
  interval and still works.
- **The guard** takes the higher of buffer top (`temperature/100`) and boiler flow
  (`temperature/103`). Neither is read as cold before it has arrived, and with only one
  arriving the guard runs on that one alone.
- **`temperature/100/Connected`** is the only thing that says a buffer reading has stopped
  being measured. At 0 — or with no reading past `config.startupGrace`, measured from the last
  connect — the window runs unguarded.
- **`state.windowKey` and `state.windowLatched`** hold the enable closed for the rest of a
  window. Set once per poll, in the same check that commands the relay, and carried across two
  windows that touch.
- **On a restart** the contact is found wherever the last run left it and nothing is written
  down. A relay found closed is left alone while any followed reading is outstanding; past
  `config.startupGrace`, silence is taken at face value. A restart part way through a shortage
  reads as entering one and opens an entry window, which costs at most an extra guarded hour.

**What it reads.** Four subscriptions: .209's `switch:0` status, `temperature/100/Temperature`,
`temperature/103/Temperature` and `temperature/100/Connected`. The temperatures
arrive unasked; the lock and the bridge state are silent signals, so those are asked for — see
[Seeding State From Other Devices](#seeding-state-from-other-devices). Following the lock
rather than deriving shortage is what keeps the count at four
([ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md)). Its own `input:0`
it reads locally.

**What it requires.**
- The one device it belongs on, matched on the ID it reports at startup. .164 is next door in
  the same cupboard and its relay looks identical, so an unrecognised device runs nothing at
  all and leaves the time clock passing through in hardware.
- `follow` with `initial_state: "match_input"` — see the relay configuration table in
  [CONTROLS.md](CONTROLS.md#relay-configuration).
- `status_ntf` in the device's MQTT config. The script asserts it, rebooting once if it was
  off, since .164 reads this device's `input:0` for its DHW demand rung.
- A synchronised clock for the scheduled slots: `sys.time` is null until the device has
  actually reached an NTP server.

**Configuration.** `config.window` carries the slots, the entry window length and the
temperature guard; `config.heatPumpLock` the status and command topics of the device it
follows; `config.device` the ID and name.

**Virtual components.** `text:200`, the status display.

---

## Common Patterns

### Re-entrancy Prevention
Most controllers use intended/actual state tracking to avoid RPC callback re-entrancy when event handlers and RPC responses interact simultaneously.

### MQTT Keepalive
The Cerbo GX publishes nothing until a value changes, so scripts ask it to republish
everything:
- An empty-payload keepalive on connect, sent from a later turn of the script's main loop
  than the subscriptions. `MQTT.subscribe` is only acted on once the script yields, so a
  request made in the same breath is answered before anything is listening. The length of
  the delay is immaterial — a millisecond would do, and the constant is 1 s.
- Every 30 seconds after that with `suppress-republish`, *unless* a rarely-changing value
  the controller gates on has still not arrived, in which case it keeps asking for the full
  republish. `vebus/276/State` changes when a generator runs, months apart, and the boiler
  input when the boiler starts or stops firing, so neither has anything to publish between
  transitions and both are only ever seen in a burst; everything else changes every few
  seconds and arrives on its own.

### Virtual Components
Scripts create virtual components for:
- User-configurable parameters (persisted across reboots)
- Status displays
- Groups (for UI organization)

### Event-Driven Architecture
Scripts use `Shelly.addEventHandler()` and `Shelly.addStatusHandler()` to react to changes immediately rather than polling.

### MQTT Subscription Budget
A script may hold **ten** MQTT subscriptions. The eleventh throws `Too many subscriptions`
and the script does not run at all, so overrunning the cap takes out every load that
controller owns, not just the one being added. Count before adding a topic.

Two ways to stay under it, both used by `surplus-dump-controller.js`:
- **Subscribe to a subtree** where a service needs several paths — `evcharger/40/#` is one
  subscription instead of three, and messages are still matched against the exact paths.
- **One wildcard per device**, not per switch — `<device-id>/status/+` covers every channel
  on that device, so stages sharing a Shelly cost one subscription between them.

### Seeding State From Other Devices
Shelly publishes status on change and does not retain it, so a controller that follows
another device starts blind. How long it stays blind is a property of the signal, not the
device: a PM channel cannot stay quiet — its power, voltage and energy readings drift, and
one republishes every 20–30 seconds whether or not it has switched — while a component with
no telemetry, such as a relay's `input:0`, says nothing until someone moves it, and a time
switch can sit still for hours.

So controllers ask rather than wait. Publishing `status_update` to a device's
`<prefix>/command` topic makes it republish every component on `<prefix>/status/…`, the
topics the follower already subscribes to: no extra subscription, no HTTP and no reply
topic, and it needs only `enable_control`, which is on by default. Asked once the
subscriptions are in — from a later turn of the main loop, as with the keepalive — and again
on every 30-second keepalive until the answer arrives, since the request is as losable as
the answer. `soc-relay-controller.js` asks the lead relay for its time switch input;
`surplus-dump-controller.js` asks each remote device for its stages' switch status, one ask
per device rather than per stage; `heating-relay-controller.js` asks .209 for the heat pump
lock and .123 for the DHW time clock; `dhw-controller.js` asks .209 for the same lock.

What a broker drop does to a followed reading differs by what the reading is for, and the
rule is in [CONTROLS.md](CONTROLS.md#who-decides-and-how-the-decision-travels).

---

## Configuration

Each script has a `config` object at the top with documented settings:

```javascript
let config = {
  cerbo: {
    host: "192.168.1.71",    // Your Cerbo GX IP
    port: 1883,
    portalId: "c0847dc9a794"  // Your VRM portal ID
  },
  // ... additional settings
};
```

**Finding your Portal ID:**
1. VRM Portal → Settings → VRM Portal ID
2. Or check Cerbo GX → Settings → Services → VRM Portal → VRM Portal ID

---

## System Design Recommendations

### Typical Off-Grid Dump Load System

1. **surplus-dump-controller.js** - Run on dimmer device for intelligent surplus management
2. **soc-relay-controller.js** - Run on multiple 1PM devices with lead relay coordination
3. **thermal-dump-controller.js** - Run on 2PM controlling pump/fan for heat recovery

How these are combined at Muttonhall is in [CONTROLS.md](CONTROLS.md). The thresholds each instance runs are the `config` table in the script itself, and nowhere else.

---

## Debugging

Enable debug mode in each script:
```javascript
debugMode: true  // or config.debugMode = true
```

Debug messages appear in Shelly console with prefixes:
- `[DEBUG-DUMP]` - soc-relay-controller.js
- `[DEBUG-SURPLUS]` - surplus-dump-controller.js
- `[DEBUG-THERMAL]` - thermal-dump-controller.js
- `[DEBUG-HEAT]` - heating-relay-controller.js
- `[DEBUG-DHW]` - dhw-controller.js

### Quick Status Check

Each controller writes a status summary to a virtual text component. You can fetch it directly via HTTP:

```bash
# soc-relay-controller (text:204)
wget -qO- http://<device>/rpc/Text.GetStatus?id=204

# surplus-dump, thermal-dump, heating-relay, dhw (text:200)
wget -qO- http://<device>/rpc/Text.GetStatus?id=200
```

Device addresses are in [POWER.md](POWER.md).

Example output:
```
{"value":"97% [On:96%, Off:95%], DHW Left Top ON, Gen 8530W, Inv 414W, VE Inverting, Input OFF, Lead OFF, HP Enabled: Monitoring","source":"sys","last_update_ts":1771542699}
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Safety Notes

- Dump loads generate significant heat - ensure proper thermal management
- Verify electrical installation by qualified electrician
- Test in dry-run mode before enabling actual control
- Monitor system behavior for first 24-48 hours
- Ensure proper circuit protection (breakers, fuses)
