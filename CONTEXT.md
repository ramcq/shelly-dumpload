# Muttonhall Energy and Heat

The off-grid power system at Muttonhall / Blackhouse Lodge and the heating plant that shares
its buffer. The words used across the scripts and documents, where a concept has more than
one plausible name.

## Language

### Energy state

**Surplus**:
Generation in excess of house consumption, which off-grid has nowhere to go once the
battery is full. Measured as available headroom, not as an export figure.
_Avoid_: Export, spill, excess

**Shortage**:
The state in which consumption should come down: the inverter is not inverting normally
off-grid, or the battery is low. Latched between 30% and 90% SOC so it does not oscillate.
Computed on Heat Pump Enable and shown by the heat pump lock, which everything else reads.
_Avoid_: Low battery, deficit, emergency

**Sustained shortage**:
Shortage that has lasted 30 minutes, long enough to be worth burning wood for. Shedding
electrical load is instant and reversible, so it acts on shortage directly; lighting the
boiler is neither, so it waits.

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
A request for hot water: the time clock calling. It releases the biomass; a shortage DHW
window does not.
_Avoid_: DHW call, hot water request

**DHW enable**:
Permission for heat to move from the buffer into the cylinders. Distinct from DHW demand:
demand asks, enable permits, and the cylinder thermostats decide whether anything
actually happens.
_Avoid_: DHW on, hot water enable

**Shortage DHW window**:
An hour, during shortage only, in which the controller closes the DHW enable in place of
the time clock. Bounded so DHW cannot run on against space heating. Not DHW demand: it
permits heat to move and asks for none.
_Avoid_: Opportunistic enable, DHW schedule, synthetic timer

**Lead relay**:
The device in a group that owns a decision; the others read it rather than recompute it.
There are two: the DHW immersion with the manual time switch on its input (.90), and Heat
Pump Enable (.209), whose relay is the shortage state.
_Avoid_: Master, primary, coordinator

**Generation gate**:
At least 500 W of generation before a dump load is enabled, whatever the SOC, so that a full
battery is not drained with nothing to replace it.
_Avoid_: Generation threshold, PV gate

**Silent signal**:
A reading with nothing to publish between changes: a relay's input, the VE.Bus state, the
boiler input, the Fröling bridge's `/Connected`. Neither Victron nor Shelly retains
messages, so a controller must ask for these (keepalive, `status_update`) rather than wait.
A Shelly PM channel or a Victron power or temperature reading republishes as it drifts, so
it arrives without asking.
