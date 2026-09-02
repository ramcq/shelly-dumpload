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

## Scripts Overview

### soc-relay-controller.js
**Device:** Shelly Plus 1PM Gen3 (DHW immersions), Shelly 1 Mini Gen3 (Heat Pump Enable)
**Purpose:** Relay on above a high SOC threshold, off below a low one, gated on VE.Bus state

Two roles, resolved from the device ID at startup:

| Role | Devices | Job |
|---|---|---|
| Dump load | .88 .90 .91 .100 | DHW immersions on a narrow SOC band, coordinated by a lead relay carrying the manual time switch |
| Shortage lead | .209 | Owns the shortage decision, expressed as its own relay — the Grant's heat pump lock. See [CONTROLS.md](CONTROLS.md) |

**Features:**
- Lead relay coordination via MQTT
- Manual time switch support (connected to lead relay input)
- User-configurable SOC thresholds
- Hysteresis derived as low = high - 1%, or stated outright where the band is wide (90/30)
- No dwell timers in either direction
- AC input suppression

**Priority Logic:** (0, 1, 2 and the checks in 4 are dump load concerns, which the shortage
lead drops; 3 and the thresholds in 4 apply in both roles)
0. **Inverter overload** - Emergency suppression if inverter output exceeds limit (overrides all)
1. **Local input** - Manual override (with inverter headroom check before enabling)
2. **Lead relay input** - Follow manual time switch on lead device (with headroom check)
3. **VE.Bus state** - Only allow dump loads when VE.Bus is Inverting (state 9). Covers: inverter off/faulted, generator/grid connected (Bulk/Absorption/Float/Passthru/Power Assist), and inverter bypassed. An unknown or stale state counts as not inverting; a state not yet received within `config.startupGrace` (3 minutes) of starting counts as nothing, since the first poll happens before MQTT has connected and the Cerbo boots slower than the Shelly
4. **SOC control** - Normal automatic operation (with generation and headroom checks before enabling)

**Generation Gate:**
- Will only enable the relay if total generation (AC-coupled + DC-coupled) exceeds a minimum threshold (default: 500W)
- Prevents enabling dump loads when there is no generation (e.g. post-outage restart, nighttime)
- Naturally self-staggers multiple dump loads: each load coming on reduces battery charging rate, and only enables when its SOC threshold is met with sufficient generation
- Turn-off is purely SOC-based and immediate — a hydro trip sheds the load at once
- Configurable via `config.minGenerationPower`

**Inverter Overload Protection:**
- Fast-path emergency suppression on MQTT receipt if inverter output exceeds 13kW
- Pre-enable headroom check: won't turn on if current inverter output + heater power >= 13kW
- Belt-and-braces polling check in checkSystemState (every 30s)
- Configurable via `config.inverter.emergencyLimit` and `config.inverter.heaterPower`

**Shortage Lead Role (.209, Heat Pump Enable):**
- `config.shortageLead.deviceId` selects the device; everything else keeps the dump load defaults
- Thresholds 90% to leave shortage, 30% to enter — a 60-point band, stated outright rather than derived
- Every dump load gate dropped: no generation gate, no headroom check, no overload fast-path. The heat pump is a load, not a dump, and overload reaches it through the VE.Bus term once the generator starts
- `followTimeSwitch: false` — nothing is wired to its input, and hot water is no reason to run the heat pump on a flat battery
- No threshold slider: `number:202` is shared with `smart-load-controller.js` and stops at 50, so both numbers stay in the file
- Status text reads `SHORTAGE: heat pump locked`, since this relay is the shortage state expressed physically
- Requires the relay to be `detached` with `initial_state: "on"` — see the relay configuration table in [CONTROLS.md](CONTROLS.md)

**Configuration:**
- Set `config.leadRelay.deviceId` to MAC address of lead relay
- Script auto-detects its role from the device ID: shortage lead, time-switch lead relay, or follower. An unreadable device ID is retried every `config.identityRetryDelay`, and no relay is commanded until the role is known
- Lead relay uses local input; others monitor via MQTT
- Asserts `status_ntf` in the device's MQTT config, rebooting once if it was off. Followers read a published switch status and nothing else, so a device that does not publish is a controller whose decision never leaves it

**Virtual Components:**
- `number:202` - High SOC Threshold (%) — matches smart-load-controller for drop-in replacement
- `text:204` - Status display
- `group:205` - Group, named for the role at creation (`Dump Load Controller`, `Heat Pump Enable`); an existing group is not renamed, and holds only the status text on the shortage source

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

## Common Patterns

### Re-entrancy Prevention
Most controllers use intended/actual state tracking to avoid RPC callback re-entrancy when event handlers and RPC responses interact simultaneously.

### MQTT Keepalive
Scripts that connect to Victron Cerbo GX send periodic keepalive messages:
- Initial keepalive on connect
- Subsequent keepalives every 30 seconds with "suppress-republish"

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

`surplus-dump-controller.js` keeps a symmetric **`minChangeTime`** (10 minutes) per stage for
a different reason: its allocator needs each stage's state to stand still long enough to
budget against — a locked stage that is on consumes its nominal power whether or not it has
been re-measured.

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
Shelly publishes status on change and does not retain it (see [POWER.md](POWER.md)), so a
controller that follows another device starts blind and a device that has not switched
recently may stay silent for a long time.

`surplus-dump-controller.js` waits for every remote stage to report before it controls
anything, so that it does not disturb loads already running — but that wait is bounded by
`statusSeedTimeout`. Past it, silent stages are assumed off and the rest are controlled
anyway; otherwise one idle immersion holds every other load off. Commanding a stage into the
position it is already in is a no-op, so guessing wrong is cheap. The bound is re-armed on
every broker reconnect, which clears the received flags.

This is a floor, not a substitute for asking. `soc-relay-controller.js` asks: a follower
publishes `status_update` to the lead relay's command topic, which makes the lead republish
every component on the topics the follower already subscribes to. That is the same trick as
the Victron keepalive — subscribe first, then induce a redundant broadcast — and it costs no
extra subscription, no HTTP and no reply topic. It needs only `enable_control`, which is on
by default.

Asked on connect, after the subscriptions land, and again on every 30-second poll until an
input status has actually arrived, since the request is as losable as the answer. A broker
drop clears the flag: a change made while the follower was away is not repeated, so the
reading is unknown afterwards rather than merely old.

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
{"value":"97% [On:96%, Off:95%], Relay ON, Gen 8530W, Inv 414W, VE Inverting, Lead OFF: Monitoring","source":"sys","last_update_ts":1771542699}
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
