# Shelly Dump Load Controllers

A collection of JavaScript scripts for Shelly devices that implement various dump load and smart load control strategies for off-grid and grid-tied solar systems with Victron Energy equipment.

## System Architecture

These scripts are designed to work with:
- **Victron Cerbo GX** - Provides MQTT broker and energy system data
- **Shelly devices** - Execute control scripts and switch dump loads
- **MQTT** - Communication between Cerbo GX and Shelly devices

Developed for an off-grid system with Victron Quattro inverters, a Cerbo GX, AC-coupled solar and hydro generation, DC-coupled hydro, and multiple resistive dump loads (immersion heaters). The scripts should be adaptable to other Victron-based systems with similar topology.

### Documentation

This file describes **each script** — what it does, how it is configured, how it is deployed. The system it runs on is documented alongside it:

| Document | Covers |
|---|---|
| [POWER.md](POWER.md) | The electrical installation: generation, battery, inverters, generator settings, and the canonical device inventory |
| [HEATING.md](HEATING.md) | The heating plant: heat pump, biomass boiler, buffer, zones, wiring, commissioning |
| [CONTROLS.md](CONTROLS.md) | The system as a whole: shortage, who decides it, what each actuator does, and the work not yet implemented |
| [CONTEXT.md](CONTEXT.md) | The glossary: buffer immersion vs DHW immersion, dump load as a mode, shortage, release vs lock, DHW demand vs DHW enable |

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

No dependencies and no build step — `tests/harness.js` loads a controller under
stubbed `Shelly`, `MQTT`, `Timer` and `Virtual` globals and exports its internals, so
the decision logic can be exercised without a device. `Shelly.call` never calls back,
so the script's own `init()` stalls after the first RPC and starts no timers.

What they cover is the failures that are expensive on live plant rather than merely wrong:
which device and channel a stage actually commands, the
[subscription budget](#mqtt-subscription-budget), and
[initialisation](#seeding-state-from-other-devices) — the last two because both fail by
stopping the whole controller, not just the stage being changed.

`soc-relay-controller.js` runs in two roles from one file, so its tests assert both: that
the shortage lead drops every dump-load gate, and that the immersions keep every one of
them.

`heating-relay-controller.js` is tested for the cases where a rung looks satisfied and is
not — a generator start reaching the rung below it, a fourteen-day timer read off a clock
that has never synchronised, a fire lit on a power system nobody can read — and for the
order of the ladder itself, since every rung ends in the same relay and only the ordering
says which of them may speak. `Shelly.call` records its callback as well as its arguments, so
a test can answer an RPC as the device would, which is what makes "the key has never been
written" reachable.

## Scripts Overview

### soc-relay-controller.js
**Device:** Shelly Plus 1PM Gen3 (DHW immersions), Shelly 1 Mini Gen3 (Heat Pump Enable)
**Purpose:** Relay on above a high SOC threshold, off below a low one, gated on VE.Bus state

Two roles, resolved from the device ID at startup:

| Role | Devices | Job |
|---|---|---|
| Dump load | .88 .90 .91 .100 | DHW immersions on a narrow SOC band, coordinated by a lead relay carrying the manual time switch, and shed while the heat pump lock is open |
| Shortage lead | .209 | No band of its own: its relay *is* shortage, expressed — the Grant's heat pump lock, which every follower reads. See [CONTROLS.md](CONTROLS.md) |

**Features:**
- Lead relay coordination via MQTT
- Manual time switch support (connected to lead relay input)
- Per-device SOC thresholds from `config.relays`, the one table this file's five deployments share
- Hysteresis derived as low = high - 1%
- Shortage decided by .209 and expressed on its relay; the immersions follow it — see [ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md)
- No dwell timers in either direction
- AC input suppression

**Priority Logic:** (everything but 1 is a dump load concern, which the shortage lead drops;
1 is the whole of what .209 does)
0. **Inverter overload** - Emergency suppression if inverter output exceeds limit (overrides all)
1. **Shortage** - On .209, its relay is the shortage state: closed when there is none, open when there is, and nothing yet heard from the Cerbo means no action either way for `config.startupGrace` (3 minutes). On a dump load, an open lock sheds the relay and returns — which covers the time switch as well as the SOC band, and saves a separate shed for the lead relay whose hardware follow has already closed it. A lock never heard from sheds nothing
2. **Local input** - Manual override (with inverter headroom check before enabling)
3. **Lead relay input** - Follow manual time switch on lead device (with headroom check)
4. **VE.Bus state** - Only allow dump loads when VE.Bus is Inverting (state 9). Covers: inverter off/faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/Power Assist), and inverter bypassed. An unknown or stale state counts as not inverting; a state not yet received within `config.startupGrace` counts as nothing. The lock covers this too, but the gate is one subscription the relay already holds and it is what keeps a dump load safe with no .209 answering
5. **SOC control** - Normal automatic operation (with generation and headroom checks before enabling)

**Shortage**, on .209 only: `VE.Bus ≠ Inverting`, or the latch — on at `SOC ≤ 30%`, off at
`SOC ≥ 90%`, held between the two, and settled by more than `config.shortage.minGeneration`
of generation where it has never been resolved. An unknown or stale VE.Bus state counts as
not inverting; the VE.Bus term overlays the latch rather than gating it, so the SOC terms
settle without waiting for a VE.Bus reading. All of it is `config.shortage`. Why the band is
60 points wide, and why an unresolved latch assumes shortage, are in
[CONTROLS.md](CONTROLS.md).

**A dump load does not compute any of this.** It follows .209's switch status, which is one
boolean and one subscription, and sheds while the lock is open. See
[ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md).

**Generation Gate:**
- Will only enable the relay if total generation (AC-coupled + DC-coupled) exceeds a minimum threshold (default: 500W)
- Prevents enabling dump loads when there is no generation (e.g. post-outage restart, nighttime)
- Shortage uses the same reading against the same threshold, but under `config.shortage.minGeneration`, which is never disabled; this gate is, for a relay that is not a dump load
- Naturally self-staggers multiple dump loads *as SOC crosses their thresholds*: each load coming on reduces battery charging rate, and only enables when its own SOC threshold is met with sufficient generation. A release that finds every threshold already satisfied is spaced by `pollOffset` instead — see [CONTROLS.md](CONTROLS.md)
- Turn-off is purely SOC-based and immediate — a hydro trip sheds the load at once
- Configurable via `config.minGenerationPower`

**Inverter Overload Protection:**
- Fast-path emergency suppression on MQTT receipt if inverter output exceeds 13kW
- Pre-enable headroom check: won't turn on if current inverter output + heater power >= 13kW
- Belt-and-braces polling check in checkSystemState (every 30s)
- Configurable via `config.inverter.emergencyLimit` and `config.inverter.heaterPower`

**Shortage Lead Role (.209, Heat Pump Enable):**
- Its row in `config.relays` carries `shortageLead: true`; everything else follows from that flag
- No SOC band of its own — its relay is closed exactly when there is no shortage, and that relay is what every follower reads
- Reads its latch back off its own relay contact on a script restart, trusting it only where the switch's last-command `source` shows something commanded it
- Every dump load gate dropped: no generation gate, no headroom check, no overload fast-path. The heat pump is a load, not a dump, and overload reaches it through the VE.Bus term once the generator starts
- `followTimeSwitch: false` — nothing is wired to its input, and hot water is no reason to run the heat pump on a flat battery
- Status text names the relay and its position — `HP Enable OFF` — with the shortage term that put it there appended, e.g. `SHORTAGE: SOC 28%`. The band it shows is `config.shortage`, `[On:90%, Off:30%]`, which reads the same way round as a dump load's because the relay closes at the high threshold and opens at the low one
- Requires the relay to be `detached` with `initial_state: "on"` — see the relay configuration table in [CONTROLS.md](CONTROLS.md)

**Configuration:**
- `config.relays` is the whole configuration: one row per device, matched on the ID the device reports at startup, carrying its name, its `high` threshold (and `low` where the band is too wide to derive), and the `leadRelay` / `shortageLead` flags that are the only things that vary by role
- Thresholds are not knobs. The immersion stagger and the shortage band are properties of the system, so they live in the table and nowhere else — not in a slider that can drift from what the documents say, and not on five devices that can drift from each other
- The device ID is read synchronously with `Shelly.getDeviceInfo()`, so the role is settled before anything else runs and there is nothing to retry. A device the table does not list runs nothing at all, which is what makes a misdirected deploy safe
- Lead relay uses local input; others monitor via MQTT
- Asserts `status_ntf` in the device's MQTT config, rebooting once if it was off. Followers read a published switch or input status and nothing else, so a device with notifications off is a decision that never leaves it

**Virtual Components:**
- `text:204` - Status display

A `number:202` left behind by `smart-load-controller.js` or by an earlier version of this
script is ignored, not read: the table is the only source of a threshold.

---

### surplus-dump-controller.js
**Device:** Shelly Pro 0/1-10V Dimmer PM
**Purpose:** Intelligent surplus power management across multiple dump loads

Advanced controller managing four 2.69kW dump loads to consume excess generation:
- **Local dimmer output** - 0-10V controlled SSR (variable 0-100%), buffer immersion 3
- **Remote Switch 0** - Shelly Pro 2PM switch 0 via MQTT RPC (ON/OFF), buffer immersion 1
- **Remote Switch 1** - Shelly Pro 2PM switch 1 via MQTT RPC (ON/OFF), buffer immersion 2
- **Remote Switch 2** - Shelly Pro 1PM switch 0 via MQTT RPC (ON/OFF), buffer immersion 4

Each remote stage names its own device and channel, so the constant stages need not
share a Shelly. The position in the list is the allocation order and is not the switch
id on the device.

**Power Sources:**
- AC-coupled generation (solar + AC hydro) - reported as "Solar" by Victron
- DC-coupled hydro turbine - small hydro on DC side

**Algorithm:**
```
Available = Solar + DC Hydro - AC Consumption + Intended Dumps - EV Headroom
```

**Key Features:**

**Intended vs Actual Power:**
- Uses *intended* dump power (not actual) to avoid feedback loops
- Calculates based on what controller *intends* to consume
- Only uses actual power in dry-run/observation mode

**Stall Detection:**
- Detects thermal cutouts (output ON, voltage present, no power)
- Keeps stalled loads ON but reallocates their power budget
- 30-second grace period (measurements lag commands)

**Priority System:**
1. Wait for initial data (avoid acting on stale state)
2. **VE.Bus state** - Only allow dumps when VE.Bus is Inverting (state 9)
3. **Low SOC protection** - Suppress if SOC < target (97% default)
4. **EV auto mode** - Use normal surplus control when EV charging in auto (prevents oscillation)
5. **High SOC protection** - Enable dumps if SOC > target (respecting inverter limit, only when no EV auto)
6. **Normal surplus control** - Sequential load allocation

**Inverter Overload Protection:**
- Enforces maximum inverter contribution limit (default: 12kW from battery)
- Calculates: `Inverter Contribution = AC Consumption - AC-Coupled Generation`
- DC-coupled sources (DC hydro) go through the inverter, so they add to available power but don't reduce inverter load
- In high SOC mode, only enables dump loads that fit within available inverter capacity
- Prevents overload when house loads (cooking, immersions, etc.) are already high
- Configurable via `config.dumpLoad.maxInverterContribution` (default: 12000W)
- Fast-path emergency shutoff at 13kW inverter output (configurable via `emergencyInverterLimit`)

**EVSE Coordination:**
- Reserves headroom when EV charger in auto mode
- Avoids fighting with EVSE's own surplus algorithm
- Headroom = max EVSE power - actual EVSE draw

**Anti-Oscillation:**
- 150W hysteresis on available power
- 5% minimum dimmer change threshold
- Sequential allocation: Switch0 → Switch1 → Dimmer
- Floor function bias (favors slight underutilization)

**Configuration:**
- Configurable heater power (2690W default)
- Dry-run mode for testing
- Target SOC threshold
- EVSE instance and max headroom

**Virtual Components:**
- `text:200` - Status display (minimal to reduce MQTT traffic)

---

### thermal-dump-controller.js
**Device:** Shelly 2PM Gen3
**Purpose:** Thermal dump heat recovery from solar dump loads

Monitors each dump load (via MQTT) for thermal cutout condition, then activates thermal dump outputs to recover waste heat from hot water tank.

**Monitored Dump Loads:** one per buffer immersion, matching the stages
`surplus-dump-controller.js` can switch. An immersion that is switchable but not listed
here reaches its thermal cutout with nothing to recover it.
- Shelly Pro 2PM - Switch 0 (buffer immersion 1)
- Shelly Pro 2PM - Switch 1 (buffer immersion 2)
- Shelly Pro Dimmer 0-10V PM - Light output (buffer immersion 3)
- Shelly Pro 1PM - Switch 0 (buffer immersion 4)

**Controlled Outputs:**
- **Output 0** - Fan coil (heating from tank)
- **Output 1** - Circulation pump (stirs tank)

**Stall Detection:**
Output ON + Voltage ≥ 200V + Power ≤ 5W = Thermal cutout detected

**Priority Logic:**
1. **Frost protection** - Unconditional ON if frost thermostat active
2. **Boiler suppression** - OFF if boiler operating
3. **Temperature check** - OFF if top tank < 70°C
4. **Thermal dump activation** - If any dump load stalled:
   - **Pump** - Always ON (stir tank)
   - **Fan coil** - ON if temp delta ≤ 5°C (top - bottom)

**Intended State Tracking:**
- Prevents RPC re-entrancy issues
- Tracks expected vs actual output state
- Only triggers checkSystemState() on unexpected changes

**Configuration:**
- Monitors Victron temperature sensors (top/bottom tank)
- Monitors boiler digital input state
- 5-minute minimum run time
- 10-second check interval

**Virtual Components:**
- `text:200` - Status display

---

### heating-relay-controller.js
**Device:** Shelly 1 Mini Gen3 (Boiler Release)
**Purpose:** Close the Fröling's volt-free release contact when anything on the site wants
wood burnt

Releasing is permission, never a command: the boiler holds its own 70 °C buffer target and
decides for itself whether it fires. So a release that turns out to be unnecessary costs
nothing, and a release granted too readily costs wood that cannot be un-burnt.

**The ladder.** One rung at a time, first match wins — the relay has only one position to be
in, so the order is what each rung is worth as an *explanation*, not what it is worth as a
reason.

| | Rung | Reads | Waits |
|---|---|---|---|
| 1 | H1, the Grant's back-up heater request | its own `input:0` | nothing — hardware `follow` has already closed the relay, and the script's job is not to undo it |
| 2 | DHW demand | .123's `input:0`, which is the DHW time clock | nothing — a request for heat the system may not have |
| 3 | The power system | `vebus/276/State`, then .209's switch status | 30 min on VE.Bus; nothing on the lock |
| 4 | Exercise run | `digitalinput/102/State`, against a timestamp in KVS | 14 days with no observed ignition |

**Rung 3 reads VE.Bus first, and that ordering is the whole of it.** .209 opens the heat pump
lock *because* VE.Bus left Inverting, so while that is true the lock is the same fact
arriving a second time — and taking it at face value would release the boiler the instant a
generator started. Reading VE.Bus first leaves the lock exactly one thing left to mean:

- **VE.Bus unreadable** — never heard, or stale after a broker drop — and the rung asks for
  nothing. The Fröling's augers, fan and pump all run off the house supply, so releasing the
  boiler because the power system cannot be read risks lighting a fire and then losing
  circulation. The Cerbo is also what connects the BMS to the inverter, so a Cerbo this
  controller cannot hear is a power system in trouble rather than one it is merely unsure
  about
- **VE.Bus not inverting** — a generator run, a passthrough, a fault, an overload start — and
  the boiler is released once that has been true for 30 minutes, which clears the fortnightly
  generator test run (20 minutes minimum runtime) without knowing anything about generators.
  *Or* immediately if the relay is already on, because whatever released it had already
  waited and a script that has just restarted cannot measure what it did not watch
- **VE.Bus inverting, lock open** — nothing but a low battery opens the lock without taking
  VE.Bus out of Inverting, and a battery at 30% is released by reaching 90% rather than by
  the minute passing. Nothing to wait for
- **VE.Bus inverting, lock closed or unheard** — nothing. An undeployed or unreachable .209
  leaves this relay with H1 in hardware, which is what it had before the Shelly was there

Why it follows a relay rather than the shortage terms is
[ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md); which case is which
is [CONTROLS.md](CONTROLS.md).

**Minimum on time:** a release *this script* granted is not withdrawn for 60 minutes,
whatever changes underneath it — by then the boiler may have begun an ignition cycle, which
is the expensive part and the part that wears. It says nothing about a relay H1 is holding
closed, or one a previous run left closed: `follow` opens the first on the H1 edge, and
undoing the hardware is not what the rule is for. See [Dwell Timers](#dwell-timers) for the
other two in the repo and how this one differs.

**The exercise run:** the rule and the reasoning are in
[CONTROLS.md](CONTROLS.md#exercise-run). What this script holds:
- `config.kvs.lastIgnition`, the timestamp every observed ignition rewrites — except a
  re-ignition inside the hold, since a lit boiler cycles several times a day and the value is
  only ever read against fourteen days
- The KVS read, seeded with the current time where there is no record *or none that can be
  read*, and retried on every poll until it lands
- `syncedNow()`, which is `sys.unixtime` only where `sys.last_sync_ts` says the clock has
  actually been set. The exercise run is the one thing here measured across a reboot, so it
  is also the only one that needs a clock the device did not invent, and it is inert without
  one. Every wait is timed within a single run and uses `Date.now()`

**A restart, with the boiler already burning:** the contact outlives the script, and every
reading that could justify it arrives over MQTT some time after the script starts. So a relay
found closed is left alone while any of those readings is still outstanding — past
`config.startupGrace`, silence is taken at face value. Nothing else is reconstructed: rung 3's
"already on" clause is what carries a burn through a redeploy, and it needs no stored state
because the relay itself is the state.

**MQTT Subscriptions:** four — the lock, the DHW time clock, `vebus/276/State` and the
boiler input. Both relay inputs and both Victron paths are silent between transitions, so all
four are asked for rather than waited on; see
[Seeding State From Other Devices](#seeding-state-from-other-devices).

**Configuration:**
- One device, matched on the ID it reports at startup. .123 is next door in the same cupboard
  and its relay looks identical, so an unrecognised device runs nothing at all and leaves the
  relay with H1 in hardware
- Requires the relay to be `follow` with `initial_state: "match_input"` — see the relay
  configuration table in [CONTROLS.md](CONTROLS.md)
- No alerting: the Fröling has its own remote monitoring, which is where boiler faults belong

**Virtual Components:**
- `text:200` - Status display

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
  the delay is immaterial — a millisecond would do.
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

### Dwell Timers
`soc-relay-controller.js` has none. A year of logged SOC replayed against its thresholds with
no timers gives under five relay operations a day — decades inside the relay's rating — and
SOC cannot chatter the way the old frequency signal could, because a load coming on bends the
slope of an integral rather than cancelling the reading.

`config.relays[].pollOffset` is not one. A dwell holds a decision that has already been
taken; the offset only moves *when* each relay takes its own, so that a heat pump lock
closing — or the manual time switch closing — does not enable every immersion against the
same inverter reading. Both of those shed on the edge, unchanged: only enabling waits. The
lead relay is never held back, since it answers the time switch in hardware.

The slot is anchored to wall clock — a relay polls when `unixtime` modulo the interval comes
round to its offset — so the offsets separate the relays however far apart their scripts
started. A device whose clock has never synchronised falls back to phasing from its own
start. See [CONTROLS.md](CONTROLS.md).

`surplus-dump-controller.js` keeps a symmetric **`minChangeTime`** (10 minutes) per stage for
a different reason: its allocator needs each stage's state to stand still long enough to
budget against — a locked stage that is on consumes its nominal power whether or not it has
been re-measured.

`heating-relay-controller.js` keeps an asymmetric **`minimumOnTime`** (60 minutes), the only
one-directional rule of the three. A dump load's whole value is that shedding it is free,
which is why `soc-relay` dropped the minimum on time it used to have; a boiler that may
already have begun an ignition cycle is the opposite case, and only in one direction. So
nothing delays the release and nothing but time withdraws it.

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
lock and .123 for the DHW time clock.

Surplus keeps a bounded wait behind that ask, `statusSeedTimeout`: it will not disturb loads
already running before every stage has reported, but past the bound the silent stages are
assumed off and the rest controlled anyway, or one idle immersion holds every other load
off. Commanding a stage into the position it is already in is a no-op, so guessing wrong is
cheap.

What a drop does to a flag differs by what the value is for. Clearing it makes the reading
unknown afterwards rather than merely old, which is right for anything that may have moved
while the broker was away — a time switch, a stage someone reached for by hand. The heat
pump lock's flag is kept instead, because an absent lock sheds nothing: forgetting it would
shed four immersions on a broker blip, and silence is not .209 saying the battery recovered.

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

How these are combined at Muttonhall, including the thresholds each instance runs, is in [CONTROLS.md](CONTROLS.md).

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

### Quick Status Check

Each controller writes a status summary to a virtual text component. You can fetch it directly via HTTP:

```bash
# soc-relay-controller (text:204)
wget -qO- http://<device>/rpc/Text.GetStatus?id=204

# surplus-dump-controller, thermal-dump-controller (text:200)
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
