# Muttonhall Power System

The off-grid electrical installation at Muttonhall / Blackhouse Lodge, Selkirk: generation,
storage, inverters, the generator, and the canonical inventory of every device the
controllers talk to.

This document owns the *facts* about the installation. [CONTROLS.md](CONTROLS.md) owns what
the controllers do with them, [HEATING.md](HEATING.md) the heating plant, and
[README.md](README.md) the scripts themselves. Where another document needs a device it
names it — *lead relay*, *Heat Pump Enable*, *buffer immersion 4* — and the address is looked up
here.

---

## Overview

Fully off-grid. No grid connection exists, so there is no export: generation in excess of
consumption has nowhere to go once the battery is full, which is the entire reason the dump
load controllers exist.

| | |
|---|---|
| Inverters | 2 × Victron Quattro 48/10000/140-2×100, single phase, parallel |
| Battery | 5 × BYD Premium LVL 15.4 kWh installed, **3 currently connected** (~46 kWh) |
| Controller | Cerbo GX, `192.168.1.71`, VRM portal `c0847dc9a794` |
| AC In 1 | 10 kVA diesel generator |
| AC In 2 | Wired for a portable 5–6 kW LPG generator, normally unused |

## Generation

| Source | Coupling | Rating | Victron service |
|---|---|---|---|
| SMA Sunny Boy ×2, solar tracker | AC | 2 × 4 kW | `pvinverter/31` — *Tracker* |
| SMA Sunny Boy, ground mount | AC | 4 kW | `pvinverter/21` — *Ground Mount* |
| Hydro generator | AC | 8–10 kW | `pvinverter/33` — *Hydro* |
| Backup hydro turbine | DC | <1 kW | `dcsource/279` |

Hydro is the base load supplier when rainfall allows and is the reason a 15 kW heat pump is
viable here at all. Solar is seasonal and, at this latitude, contributes little in the
months when heat is wanted.

## Power flow

Understanding this is critical for safe operation, because "generation" and "inverter load"
are not the same quantity.

**AC-coupled generation (AC output side).** The PV inverters and the AC hydro connect to the
Quattros' **AC output**, not an AC input. That power flows directly to loads on the AC
output and does **not** count against the inverter's battery contribution limit. Victron
reports it as `system/0/Ac/PvOnOutput/L1/Power`.

**DC-coupled generation (battery side).** The small hydro turbine connects on the DC side,
so its power must pass through the inverter to reach AC loads. It **does** consume inverter
output capacity.

**Inverter contribution** is the net power drawn from the battery through the inverter:

```
Inverter Contribution = AC Consumption − AC-Coupled Generation
```

Exceeding the inverter's limit causes overload warnings and can trip the system. The
controllers hold a 12 kW contribution limit with a 13 kW emergency threshold, leaving
headroom for unexpected household loads. See [CONTROLS.md](CONTROLS.md) for how that budget
is allocated and where the overload risk still sits.

**Generator and AC hydro interact badly.** A diesel start can knock the AC-coupled hydro
offline on frequency or voltage mismatch. Always verify the hydro restarted after a
generator run or a power event. DC-coupled hydro is unaffected, being on the battery side.

## Generator

`Settings/Generator0`, confirmed August 2026:

| Setting | Value |
|---|---|
| Autostart | Enabled |
| SOC start / stop | **20% / 80%** |
| Start / stop timers | 20 s |
| Minimum runtime | 20 min |
| Inverter overload start | Enabled, 30 s |
| Inverter high temperature start | Enabled |
| Test run | Every 14 days, 20 min, skipped if it has run within the hour |
| AC load, battery current, battery voltage conditions | Disabled |
| Quiet hours | Disabled |

> **Trap:** `Settings/Generator1` also exists and is populated with defaults. It is the
> unused second generator instance. Reading it reports autostart disabled and a 80/90 SOC
> window, all of which is false. The live service is `generator/0`, settings under
> `Settings/Generator0`.

These numbers are what the shortage thresholds in [CONTROLS.md](CONTROLS.md) are calibrated
against — particularly the fact that the generator stops charging at 80%.

---

## Device inventory

The canonical list. Correct it here and nowhere else.

### Network

| IP | Device | Role |
|---|---|---|
| 192.168.1.71 | Cerbo GX | MQTT broker, VRM gateway |
| 192.168.1.65 | Shelly Pro 1PM `shellypro1pm-5c013b056870` | Buffer immersion 4 — switched by `surplus-dump-controller.js` on .251 over MQTT RPC |
| 192.168.1.88 | Shelly 1PM Gen3 `shelly1pmg3-543204558c6c` | DHW immersion — Left Top |
| 192.168.1.89 | Shelly Pro 3EM `shellypro3em-2cbcbba67614` | *Heat Pump Power* — **triphase** profile, heat pump on phase A. Read it as `em:0` (`a_act_power`); `EM1.GetStatus` returns 404 in this profile |
| 192.168.1.90 | Shelly 1PM Gen3 `shelly1pmg3-543204558fc8` | DHW immersion — Left Bottom, **lead relay**, time switch on its input |
| 192.168.1.91 | Shelly 1PM Gen3 `shelly1pmg3-dcda0ce04fb0` | DHW immersion — Right |
| 192.168.1.100 | Shelly 1PM Gen3 `shelly1pmg3-dcda0ce06e98` | DHW immersion — Annex |
| 192.168.1.123 | Shelly 1 Mini Gen3 `shelly1minig3-48f6ee8e8780` | DHW Enable |
| 192.168.1.156 | Shelly 2PM Gen3 `shelly2pmg3-e4b3232c1810` | Thermal dump — fan coil (0) and circulation pump (1) |
| 192.168.1.161 | Shelly Pro 2PM `shellypro2pm-ec6260a03d70` | Buffer immersions 1 and 2 |
| 192.168.1.164 | Shelly 1 Mini Gen3 `shelly1minig3-d885ac0818d0` | Boiler Release |
| 192.168.1.171 | Shelly 1 Mini Gen3 `shelly1minig3-48f6ee872f10` | Isolating relay: runs the pre-PHE pump when either house or annex DHW calls — **not permanently powered**, see below |
| 192.168.1.172 | Victron EVCS | EV charging station |
| 192.168.1.175 | Shelly Pro 2 Cover `shellypro2cover-34987a4943ec` | Turbine valves |
| 192.168.1.200 | SMA Sunny Boy | Ground mount, SunSpec |
| 192.168.1.209 | Shelly 1 Mini Gen3 `shelly1minig3-d885ac0a3668` | Heat Pump Enable |
| 192.168.1.245 | Fröling Lambdatronic 3200 | Modbus TCP :502, read by `dbus-froeling` |
| 192.168.1.251 | Shelly Pro 0/1-10V Dimmer PM `shellypro0110pm-8813bfe0e128` | Buffer immersion 3, and host of `surplus-dump-controller.js` |

### Victron services

| Instance | Service | Notes |
|---|---|---|
| `vebus/276` | Quattro pair | `State` 9 = Inverting is the normal off-grid state |
| `battery/512` | BYD Premium LV | SOC source via `system/0/Dc/Battery/Soc` |
| `pvinverter/21`, `/31`, `/33` | Ground Mount, Tracker, Hydro | AC-coupled |
| `dcsource/279` | Backup hydro turbine | DC-coupled |
| `evcharger/40` | EV charging station | Modbus TCP |
| `generator/0` | Generator start/stop | See above |
| `tank/20`, `/21` | Diesel, water | |
| `temperature/100`, `/101`, `/103` | Buffer top, buffer bottom, boiler flow | From `dbus-froeling` |
| `digitalinput/102` | Boiler operating contact | `FurnaceStatus`, from `dbus-froeling` |

Every Shelly is registered with `dbus-shelly-local`. Two-channel devices take one instance
per channel, and the instance order is **not** the channel order:

| Instance | Device | Channel | Load |
|---|---|---|---|
| `acload/50` | .90 | 0 | DHW immersion, Left Bottom — the lead relay |
| `acload/51` | .100 | 0 | DHW immersion, Annex |
| `acload/52` | .88 | 0 | DHW immersion, Left Top |
| `acload/53` | .251 | dimmer | Buffer immersion 3 |
| `acload/54` | .91 | 0 | DHW immersion, Right |
| `acload/55` | .156 | **1** | Circulation pump |
| `acload/56` | .156 | **0** | Garage fan coil |
| `acload/57` | .161 | **1** | Buffer immersion 2 |
| `acload/58` | .161 | **0** | Buffer immersion 1 |
| `acload/59` | .65 | 0 | Buffer immersion 4 |
| `acload/60` | .89 | — | Heat pump meter, no switchable output |

### The intermittently powered relay

The Shelly 1 Mini at .171 is wiring, not automation: it isolates the house-DB DHW control
circuit from the atrium-DB pump control circuit, so that a DHW call from either the house or
the annex runs the pre-PHE pump. Its supply comes from the circuit it isolates, so it is on
the network only while a DHW zone is actually calling. DHW Enable being closed is not enough:
its supply comes from the zone valve end switches, downstream of the cylinder stats.

Consequences, which apply to it and to anything wired like it:

- **Its absence from a network scan is normal**, not a fault, and its presence is not a
  reliable signal of anything.
- **Never deploy a script to it** and never let another controller subscribe to it or RPC
  it. A device that loses power as a matter of routine cannot hold state, cannot be polled,
  and would take a dependent controller down with it.
- Being on WiFi buys nothing and costs a join/leave cycle every time a DHW zone calls.

### Shelly MQTT configuration

Every scripted device connects to the Cerbo's broker. The working configuration, which any
new controller device must match:

```
server:      192.168.1.71:1883
status_ntf:  true      (so other devices can observe its switch and input state)
rpc_ntf:     false
enable_rpc:  true only on devices another controller drives over MQTT (.65, .161, .251)
```

`status_ntf` is what publishes `<device-id>/status/switch:0` and `.../status/input:0`, which
is how devices follow one another.

> **These publications are on change, and are not retained.** A subscriber that connects
> between two edges learns nothing until the next one, so any controller that follows another
> device must seed its view with an HTTP `Switch.GetStatus` at startup rather than wait. This
> applies to the existing lead relay follow as much as to anything new.

What a controller does about that gap is the script's business — see the subscription and
seeding patterns in [README.md](README.md); relay `in_mode` and `initial_state` are set out
in [CONTROLS.md](CONTROLS.md).


---

## Known issues

| Item | Status |
|---|---|
| `acload/55` and `/56` both named *Garage Fan Coil*; `/57` and `/58` both named *Buffer Immersion 1 & 2* | VRM cannot tell the fan coil from the circulation pump, or immersion 1 from immersion 2. Cosmetic, but the instance-to-channel mapping above is the only way to read them correctly |
| Only 3 of 5 BYD batteries connected | Roughly halves the energy behind the shortage band |
