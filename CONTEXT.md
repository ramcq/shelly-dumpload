# Muttonhall Energy and Heat

The off-grid power system at Muttonhall / Blackhouse Lodge and the heating plant it shares a
buffer with. This glossary fixes the words used across the controller scripts and the four
documents — [README.md](README.md), [POWER.md](POWER.md), [HEATING.md](HEATING.md) and
[CONTROLS.md](CONTROLS.md) — where several concepts have more than one plausible name and two
different device classes were previously called the same thing.

## Language

### Energy state

**Surplus**:
Generation in excess of house consumption, which off-grid has nowhere to go once the
battery is full. Measured as available headroom, not as an export figure.
_Avoid_: Export, spill, excess

**Shortage**:
The system state entered when battery SOC falls below the shortage threshold, or the
inverter is in any state other than inverting nominally off-grid, and left only when SOC
has recovered above the exit threshold and the inverter is back to normal. It is a latched
state with wide hysteresis, not an instantaneous reading.
_Avoid_: Low battery, deficit, emergency

**Sustained shortage**:
Shortage that has persisted long enough to be worth burning wood for. Shedding electrical
load is instant and reversible, so it acts on shortage directly; lighting the boiler is
neither, so it waits — except when the shortage is a low battery, which is never
transient.

**Dump load**:
A mode of use, not a device class: an electrical load run for the purpose of dissipating
surplus rather than because someone asked for its output.
_Avoid_: Diversion load, sink

### Heat

**Buffer**:
The 1500 litre thermal store shared by every heat source and every heat consumer on the
site. The single point at which generation, biomass and space heating meet.
_Avoid_: Tank, accumulator, thermal store

**Buffer immersion**:
An immersion heater in the buffer. Always a dump load — it exists only to absorb surplus,
and nothing else ever asks for it.
_Avoid_: Dump immersion, buffer element

**DHW immersion**:
An immersion heater in a domestic hot water cylinder. Dual-purpose: scheduled water
heating when someone wants hot water, a dump load when surplus is available.
_Avoid_: Cylinder immersion, tank immersion

**Cylinder**:
A domestic hot water vessel. There are three — two in the house, one in the annex — each
with its own thermostat, and the plural matters: several design decisions exist because
the heat pump can only manage one.
_Avoid_: Tank, calorifier

**Heat loop**:
The primary circuit carrying heat from the plant room to the house side of the plate
heat exchanger.

**Bivalent point**:
The outside temperature below which the heat pump alone cannot meet the building's heat
loss and the biomass supplements it. A property of the building and the plant, unrelated
to whether the power system is in shortage.

### Control

**Release** (the biomass):
To permit the Fröling to fire. The boiler decides for itself whether it actually burns,
based on its own buffer target; releasing it is permission, never a command to burn.
_Avoid_: Start the boiler, fire the boiler, enable biomass

**Lock** (the heat pump):
To open the Grant's volt-free lock contacts so the heat pump takes no demand. Closed
contacts are the running state, so the heat pump is locked by the *absence* of a signal.
_Avoid_: Disable, switch off, stop the heat pump

**DHW demand**:
A request for hot water: the time clock calling, whether that is the physical clock or a
window synthesised in its place. A reason to want heat moved, and therefore a reason to
release the biomass.
_Avoid_: DHW call, hot water request

**DHW enable**:
Permission for heat to move from the buffer into the cylinders. Distinct from DHW demand:
demand asks, enable permits, and the cylinder thermostats decide whether anything
actually happens.
_Avoid_: DHW on, hot water enable

**Shortage DHW window**:
A bounded period, during shortage only, in which the controller closes the DHW enable in
place of the time clock the user would otherwise flip by hand. Bounded because the point
is not only to make hot water but to stop making it, so DHW cannot run on indefinitely
against space heating. It is not DHW demand: it permits heat to move and asks for none,
so it releases nothing.
_Avoid_: Opportunistic enable, DHW schedule, synthetic timer

**Lead relay**:
The one device in a coordinated group that owns a decision and expresses it, which the
others observe rather than recompute. The manual time switch group and the shortage state
each have one.
_Avoid_: Master, primary, coordinator

**Generation gate**:
The precondition that measurable generation exists before any dump load is enabled,
independent of SOC. Prevents dumping from a charged battery when no generation will replace it.
