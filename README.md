# Shelly Dump Load Controllers

A collection of JavaScript scripts for Shelly devices that implement various dump load and smart load control strategies for off-grid and grid-tied solar systems with Victron Energy equipment.

## System Architecture

These scripts are designed to work with:
- **Victron Cerbo GX** - Provides MQTT broker and energy system data
- **Shelly devices** - Execute control scripts and switch dump loads
- **MQTT** - Communication between Cerbo GX and Shelly devices

### Power Flow Architecture

Understanding the power flow is critical for safe operation:

**AC-Coupled Generation (AC Output Side):**
- PV inverters and AC-coupled hydro generators connect to the **AC output** (not AC input)
- Power from AC-coupled sources flows directly to loads on AC output
- This power does NOT count against the inverter's battery contribution limit
- Victron reports this as "Solar" power (system/0/Ac/PvOnOutput/L1/Power)

**DC-Coupled Generation (Battery Side):**
- DC-coupled sources (small hydro turbine) connect to the DC side
- Power must go through the inverter to reach AC loads
- This power DOES count against the inverter's output capacity limit

**Inverter Contribution:**
- The inverter has a maximum power limit for battery discharge (typically 14-15kW)
- **Inverter Contribution = AC Consumption - AC-Coupled Generation**
- DC-coupled generation goes through the inverter, so it doesn't reduce inverter contribution
- This is the net power being drawn from the battery through the inverter
- Exceeding this limit causes inverter overload warnings and can trip the system

**Critical Safety Limit:**
The surplus-dump-controller enforces a 12kW inverter contribution limit (leaving 2kW headroom for unexpected loads like kettles, immersions, etc.). When battery SOC is high and dump loads are enabled, the controller calculates:
```
Current Inverter Contribution = AC Consumption - AC-Coupled Generation
Available Capacity = 12kW - Current Inverter Contribution
```
DC-coupled sources (like the DC hydro turbine) add power but go through the inverter, so they don't reduce the inverter contribution calculation. Dump loads are only enabled up to the available capacity to prevent overload.

**Generator/AC Hydro Interactions:**
- Diesel generators can knock AC-coupled hydro generators offline when they start (frequency/voltage mismatch)
- Always verify AC hydro has restarted after diesel generator test runs or power events
- Monitor PV Inverter [33] power output to confirm AC hydro operation
- DC-coupled hydro is not affected by generator starts as it's on the battery side

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

## Scripts Overview

### victron-mqtt.js
**Device:** Shelly Plus 1PM (or any Shelly with virtual components)
**Purpose:** MQTT bridge providing Victron data to other Shelly scripts

Connects to Victron Cerbo GX via MQTT and creates virtual components displaying:
- Battery State of Charge (SOC %)
- AC input connection status (Grid/Generator/Shore connected or not)

Other scripts can read these virtual components to make control decisions based on Victron system state.

**Virtual Components Created:**
- `number:210` - Battery SOC
- `boolean:211` - AC Input Connected
- `group:212` - Cerbo GX Monitor group

---

### frequency-controller.js
**Device:** Shelly Plus 1PM Gen3
**Purpose:** Grid frequency response for demand management

Monitors grid frequency and controls relay based on configurable thresholds. Designed for grid stabilization programs where loads are shed/added based on frequency.

**Features:**
- User-configurable high/low frequency thresholds
- Consecutive high reading requirement (prevents false triggers)
- Minimum on-time enforcement (10 minutes default)
- Input override support
- Real-time status display

**Control Logic:**
1. Monitor grid frequency via Shelly's built-in measurement
2. Turn ON when frequency ≥ high threshold for N consecutive readings
3. Turn OFF when frequency ≤ low threshold AND minimum on-time elapsed
4. Local input can override (manual control)

**Virtual Components:**
- `number:200` - High Frequency Threshold (Hz)
- `number:201` - Low Frequency Threshold (Hz)
- `text:204` - Status display
- `group:205` - Frequency Controller group

---

### smart-load-controller.js
**Device:** Shelly Plus 1PM Gen3
**Purpose:** Dual-mode controller (frequency OR battery SOC)

Combines frequency-based and SOC-based control in a single script. Automatically switches between modes based on availability of Victron SOC data.

**Operating Modes:**

**SOC Mode** (when Victron data available):
- Turn ON when SOC ≥ high SOC threshold
- Turn OFF when SOC ≤ low SOC threshold
- Suppressed if AC input connected

**Frequency Mode** (fallback when no SOC data):
- Same logic as frequency-controller.js

**Dependencies:**
- Optionally uses virtual components from `victron-mqtt.js` (components 210, 211)
- Can operate standalone using only frequency data

**Virtual Components:**
- `number:200` - High Frequency Threshold
- `number:201` - Low Frequency Threshold
- `number:202` - High SOC Threshold
- `number:203` - Low SOC Threshold
- `text:204` - Status display
- `group:205` - Smart Load Controller group

---

### dump-load-controller.js
**Device:** Shelly Plus 1PM Gen3
**Purpose:** Coordinated SOC-based dump load control with manual override

Simplified dump load controller with multi-device coordination. One device acts as "lead relay" with manual time switch, and other relays follow its state.

**Features:**
- Lead relay coordination via MQTT
- Manual time switch support (connected to lead relay input)
- User-configurable SOC thresholds
- Auto-calculated hysteresis (low = high - 1%)
- AC input suppression

**Priority Logic:**
0. **Inverter overload** - Emergency suppression if inverter output exceeds limit (overrides all)
1. **Local input** - Manual override (with inverter headroom check before enabling)
2. **Lead relay input** - Follow manual time switch on lead device (with headroom check)
3. **AC input check** - Suppress if grid/generator connected
4. **SOC control** - Normal automatic operation (with headroom checks before enabling)

**Inverter Overload Protection:**
- Fast-path emergency suppression on MQTT receipt if inverter output exceeds 13kW
- Pre-enable headroom check: won't turn on if current inverter output + heater power >= 13kW
- Belt-and-braces polling check in checkSystemState (every 30s)
- Configurable via `config.inverter.emergencyLimit` and `config.inverter.heaterPower`

**Configuration:**
- Set `config.leadRelay.deviceId` to MAC address of lead relay
- Script auto-detects if current device is lead relay
- Lead relay uses local input; others monitor via MQTT

**Virtual Components:**
- `number:202` - High SOC Threshold (%) — matches smart-load-controller for drop-in replacement
- `text:204` - Status display
- `group:205` - Dump Load Controller group

---

### surplus-dump-controller.js
**Device:** Shelly Pro 0/1-10V Dimmer PM
**Purpose:** Intelligent surplus power management across multiple dump loads

Advanced controller managing three 2.69kW dump loads to consume excess generation:
- **Local dimmer output** - 0-10V controlled SSR (variable 0-100%)
- **Remote Switch 0** - Shelly Pro 2PM via MQTT RPC (ON/OFF)
- **Remote Switch 1** - Shelly Pro 2PM via MQTT RPC (ON/OFF)

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
2. **Generator suppression** - Turn off all loads if AC source active
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

Monitors three separate dump loads (via MQTT) for thermal cutout condition, then activates thermal dump outputs to recover waste heat from hot water tank.

**Monitored Dump Loads:**
- Shelly Pro 2PM - Switch 0
- Shelly Pro 2PM - Switch 1
- Shelly Pro Dimmer 0-10V PM - Light output

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

### Minimum On-Time
Most controllers enforce minimum on-time (typically 10 minutes) to:
- Prevent rapid cycling
- Reduce relay wear
- Allow loads to stabilize

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

### Typical Solar Dump Load System

1. **victron-mqtt.js** - Run on one Shelly to provide SOC data
2. **surplus-dump-controller.js** - Run on dimmer device for intelligent surplus management
3. **thermal-dump-controller.js** - Run on 2PM controlling pump/fan for heat recovery

### Grid-Tied with Frequency Response

1. **frequency-controller.js** - Run on controllable loads
2. Configure thresholds per utility requirements

### Off-Grid SOC Management

1. **victron-mqtt.js** - Provide SOC to network
2. **dump-load-controller.js** - Run on multiple 1PM devices with lead relay coordination

---

## Debugging

Enable debug mode in each script:
```javascript
debugMode: true  // or config.debugMode = true
```

Debug messages appear in Shelly console with prefixes:
- `[DEBUG-SURPLUS]` - surplus-dump-controller.js
- `[DEBUG-THERMAL]` - thermal-dump-controller.js
- `[DEBUG-CERBO]` - victron-mqtt.js
- `[DEBUG]` - other controllers

---

## License

These scripts are provided as-is for educational and personal use.

---

## Safety Notes

- Dump loads generate significant heat - ensure proper thermal management
- Verify electrical installation by qualified electrician
- Test in dry-run mode before enabling actual control
- Monitor system behavior for first 24-48 hours
- Ensure proper circuit protection (breakers, fuses)
