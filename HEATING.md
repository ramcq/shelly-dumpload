# Muttonhall Heating System

The heating plant at Muttonhall / Blackhouse Lodge, Selkirk: a Grant Aerona 290 heat
pump and a Fröling biomass boiler sharing a 1500 litre buffer with four buffer
immersions, three heating circuits, and the Shelly relays that let the off-grid power
system fall back to biomass when electricity is short.

This document covers the plant: what is installed, how it is piped, how it is wired and how
it is configured. What the controllers *do* with it — shortage, the heat pump lock, biomass
release, DHW enable — is in [CONTROLS.md](CONTROLS.md). The electrical installation and the
device inventory are in [POWER.md](POWER.md), the scripts in [README.md](README.md), and the
vocabulary all four share in [CONTEXT.md](CONTEXT.md).

The heating plant and the power system are coupled — same buffer, same surplus.

---

## Design

Space heating was historically all biomass, with hot water either from biomass in winter
or direct electric immersion in summer. The heat pump moves day-to-day heating off the
boiler at CoP ~3, puts the house on weather compensation, and is remotely controllable.
It runs on the house supply like any other load — it is not surplus-gated. The only
reason to disable it is a prolonged shortage of power, at which point the biomass takes
over.

| Parameter | Value | Source |
|---|---|---|
| Design external temperature | −5.4 °C | Heat Pump Compliance Certificate |
| Total heat loss at design condition | 17.7 kW | Compliance certificate |
| Revised heat loss (design notes) | 19.5 kW | RH1663 design notes |
| Specific heat loss | 929 W/°C | Design notes |
| Heat pump output | 15.5 kW | Grant Aerona 290 |
| Design flow temperature | 45 °C at design day | Compliance certificate |
| Bivalent point | −1 °C | Design notes / commissioning |
| Buffer volume | 1500 litres | Commissioning report |
| Usable buffer energy, 70 → 35 °C | ≈61 kWh — ~3 h of full load at −5.4 °C, ~4 h at −1 °C, or ~15 h of the 4 kW shortfall below −1 °C | Design notes |

### Design temperature: −5.4 °C on paper, arguably −7.2 °C

MCS takes the design external temperature from CIBSE Guide A (2015) Table 2.5 — the
nearest of 14 weather stations to the postcode centroid. For TD7 that is Edinburgh
(Gogarbank, 57 m), 99.6% design temperature −5.4 °C, which is the figure on the
certificate.

But the same method reduces that by 0.6 °C per whole 100 m of altitude above the
reference station. At ~370 m this site is 313 m above Gogarbank, so the corrected design
temperature is **−7.2 °C** and the certificate appears to have skipped the adjustment.
Scaling the certificate's 17.7 kW to −7.2 °C gives ~19 kW — near enough the design
notes' 19.5 kW that the design notes look like the altitude-corrected number and the
certificate the uncorrected one.

### Why 15.5 kW

15 kW is the largest ASHP available single-phase, and it covers 300+ days a year.
Generation is 8 kW of hydro when rainfall allows, plus solar.

The −1 °C bivalent point is softer than it looks. The house is least likely to be
occupied when it is coldest, and the setpoint can be lowered via the Grant until the
load matches what the heat pump can dissipate. With 8 kW+ generation there is ~3 kW of
immersion surplus on top, so ~18 kW into the buffer — enough for conditions well below
the design day without touching the biomass.

100% cover (2 × 12 kW Vaillant aroTHERM) and a cascade (2 × Nibe 2050 10 kW) were
rejected: disproportionately expensive for 4 kW the buffer can carry anyway, and could easily outstrip available power.

The primary pipework from the plant room is only 28 mm, so the system is designed wide-ΔT
(ΔT10, as for biomass) rather than ΔT5, and the heat pump is piped **directly into the
buffer** to maintain its own flow rate.

---

## Equipment

### Heat pump

Grant Aerona 290, HPR290155, 15.5 kW, R290, serial 140126810010125, with the Aerona 290
Smart Controller Kit (HP290SMART) and an Aerona3 Smart Wired Thermostat. On a concrete
plinth behind the LPG cylinders by the plant room, condensate draining within the plinth.
Outdoor sensor wired to the Smart Controller and mounted on the garage exterior beside
the unit.

Installed by Renewable Heat Installation and Servicing Ltd (MCS NAP-25519), technical
supervisor Barry Sharp, commissioned 24 July 2026, MCS certificate MCS-02867816-M,
SCOP 3.88 at 45 °C. Project references RH1663 / REN-003505 / job 5441.

### Buffer, biomass and immersions

1500 litre buffer shared by the heat pump, a Fröling T50e (50 kW) and four ~2.7 kW
(12 A) buffer immersions. A plate heat exchanger separates the plant room primary from
the house side, with the pre-PHE circulation pump in the atrium cupboard.

Buffer immersions are only ever dump loads — nothing but surplus ever asks for them. The
DHW immersions in the cylinders are the dual-purpose ones; see [CONTEXT.md](CONTEXT.md).

| Immersion | Switched by | IP | Status |
|---|---|---|---|
| 1 and 2 | Shelly Pro 2PM switches 0/1, driven over RPC by `surplus-dump-controller.js` | 192.168.1.161 | Live |
| 3 | Shelly Pro 0/1-10 V Dimmer PM driving an SSR, variable 0–100% | 192.168.1.251 | Live |
| 4 | Shelly Pro 1PM, the third constant stage, driven over RPC by `surplus-dump-controller.js` | 192.168.1.65 | Live |

Labelled `DUMP IMMERSION 1/2/3` at the isolators in the buffer shed. All four are metered
into VRM.

### Buffer sensor pockets

The topmost and bottommost pockets are the Fröling's — its pump is
flow-temperature-modulated so it needs true top and bottom, and those readings also reach
Victron via `dbus-froeling` for `thermal-dump-controller.js`. The Grant takes the second
from top and second from bottom (`BT`, `BB`). Since the heat pump's ΔT-modulated pump
mixes the tank as it loads, the Grant's pair read near-homogeneous; the Fröling pair are
the real stratification reading.

---

## Hydraulics

```
                    ┌──────────────────┐
  Fröling T50e ────►│                  │
  (biomass, 70 °C)  │                  │
                    │   1500 L BUFFER  │◄──── 4 × 2.7 kW immersions
  Grant Aerona 290 ►│                  │      (dump loads, surplus hydro/PV)
  (direct, 28 mm,   │                  │
   own flow rate)   └────────┬─────────┘
                             │ heat loop (28 mm primary, plant room → house)
                             ▼
                    ┌──────────────────┐
                    │  Plate heat exch │   pre-PHE pump in atrium cupboard
                    └────────┬─────────┘
                             │ house side
        ┌────────────────────┼────────────────────┬─────────────────┐
        ▼                    ▼                    ▼                 ▼
   Circuit 1            Circuit 2            Circuit 3          DHW (unmixed)
   Annex UFH            House rads           Atrium UFH         2 × house cylinder
   manual blend 35 °C   ESBE mixer, WC       manual blend 35 °C 1 × annex cylinder
```

A bypass was made by removing the entrance
vestibule TRV and replacing with a Danfoss lockshield so guests can't close it.

---

## Zones

| Circuit | Zone | Emitter | Grant type | Regulation | Blending | Day / night |
|---|---|---|---|---|---|---|
| 1 | Annex | UFH | `Radiators` | Fixed 35 °C, hyst 1.0 °C | Manual valve | 20.5 / 18.0 °C |
| 2 | House rads | Radiators | (mixed) | Weather, curve 1.1, shift 0 | ESBE VRG232 + ARA645 | n/a |
| 3 | Atrium | UFH | `Floor` | Fixed 35 °C, hyst 1.0 °C | Manual valve | 20.5 / 18.0 °C |

All three on schedule mode with `Thermostat pump blockade = YES`; circuits 1 and 3 are
`Pump only`.

The Grant assumes circuit 1 is the direct, highest-temperature zone and won't take a
mixed circuit there. The radiators need a motorised mixer — the buffer can be driven to >70 °C by
the biomass or the immersions — so they went on circuit 2 and the annex took circuit 1,
declared as a fixed-temperature `Radiators` circuit while physically being UFH behind a
manual blending valve.

### Emitters

UFH in the new parts - annex and atrium. Radiators in the original house (RH1663 rad sizing at 45 °C flow / 42 °C MRT): Compact
K2 in Utility 1, Bedroom 2 (×2), Kitchen 3 (×2), Living 1, Dining (×2), Bedroom 1,
Bedroom 5, Bedroom 6, Landing 1; P+ towel rails in Baths 1–8.

Living 1 (−508 W) and Kitchen 3 (−361 W) are short of their heat loss at 45 °C, accepted
on stove and cooking gains.

Key rooms have Honeywell Evohome TRVs at fixed setpoints as overheat limits — 19 °C bedrooms,
21 °C living — kept mainly for logging and remote monitoring. Towel rails and secondary
rads are on Danfoss TRVs.

> The towel rails are plumbed onto the DHW circuit, not the radiator circuit, so the
> mixed-rads / unmixed-DHW split isn't quite right — they run at cylinder temperature
> and sit outside the weather-compensated zone.

### DHW

Normally direct electric immersion off surplus — the DHW immersions, which are dump loads
whenever surplus is available and intentional water heating whenever the time switch says
so. Indirect DHW from the buffer is the fallback when power is short and the biomass is
running, on windows the controller opens in place of the time clock. There is no case for
taking DHW from the buffer while the immersions can do it.

The entire DHW system is powered from the house DB. One time clock feeds three cylinder stats (2 house, 1 annex) via the DHW Enable relay.
Each stat directly powers its relevant (one in annex, one in house) pump and zone valve; the zone valve end switch powers a relay in the atrium — the Shelly 1 Mini at 192.168.1.171,
acting purely as an isolating relay — which switches on a circuit on the UFH controller that runs the
heat loop pump, powered from the atrium DB. So the heat loop pump runs whenever any heating or DHW zone calls. The
annex blending valve is set to 40 °C.

The Grant has no DHW cylinder configured at all, by design:

- It supports one cylinder; there are three.
- Heat pump DHW would need the buffer bypassed during cylinder loading, or making hot
  water would drag all 1500 litres to cylinder temperature.
- It buys very little. With enough power for heat pump heating, the marginal power for
  immersion DHW is incidental; without it, both heating and DHW come from the biomass.
  The in-between states aren't useful enough to justify the complexity.

Which is why the decision — immersion or biomass — belongs in the DHW Enable relay. When
that relay closes, and why, is in [CONTROLS.md](CONTROLS.md).

---

## Grant wiring centre

In the atrium cupboard with the circulation pumps and the radiator mixer/pump set.
Labelled enclosures: `Grants Smart Controller`, `HP Lock Control`, `Biomass Control`,
`House DHW Control`, `Pre PHE Pump Control` (Wunda UFH controller, aggregates zone/DHW demands to activate PHE pump),
`Heating Wiring`, `240v Distribution Centre / Shelly Control`. Modbus and the buffer
sensors reach the atrium from the garage over the existing 24-core signal cable.

| Terminal | Numbers | Function | Use here |
|---|---|---|---|
| `H1-P` | 13 & 14 | Circuit 1 switched live + neutral | Annex UFH pump |
| `H2-M` | 3, 4 & 5 | Circuit 2 mixing valve | ESBE ARA645 actuator |
| `H2-P` | 15 & 16 | Circuit 2 switched live + neutral | Radiator circuit pump |
| `H3-P` | 17 & 18 | Circuit 3 switched live + neutral | Atrium UFH pump |
| `H1` | **19 & 20** | Back-up heater / immersion relay switch (fused F3) | **Switch input to Boiler Release** |
| `LOCK` | **23 & 24** | Volt-free "heat pump lock" | **Heat Pump Enable contacts** |
| `BT` / `BB` | 45 & 46 / 47 & 48 | Buffer upper / lower sensors | 2nd-top / 2nd-bottom pockets |
| `T1` | 37 & 38 | Circuit 1 volt-free switch, or boiler flow sensor when AHS enabled | Pipe sensor on the biomass flow |
| `WS` | 49 & 50 | Outdoor sensor | Garage exterior, by the heat pump |

Grant's Additional Heat Source support needs the EvoLink hydraulic station to do pump
and mixer control, so `AHS enable` is **NO** and the biomass runs off the back-up heater
output instead. A pipe sensor on the biomass flow and a spare 2-core between the house
cylinder and atrium cupboards keep the AHS route open if EvoLink is ever added.

| Heaters (service menu) | Value |
|---|---|
| Back-up heater | YES, 60 min delay, not in defrost |
| Outside temp. start heater | YES, −1 °C |
| Outside temp. force heater | YES, −7 °C |
| DHW heater | NO (15 min delay) |

---

## Shelly relays

Three Shelly 1 Mini Gen 3 in the atrium cupboard, wired into the Grant wiring centre and the
biomass and DHW controls. What they are wired across is below; when each one operates is in
[CONTROLS.md](CONTROLS.md).

| Name | IP | Wired across |
|---|---|---|
| Heat Pump Enable | 192.168.1.209 | `LOCK` (23 & 24), the Grant's volt-free heat pump lock |
| Boiler Release | 192.168.1.164 | Fröling boiler release, with `H1` (19 & 20) as its switch input |
| DHW Enable | 192.168.1.123 | In series between the DHW time clock and the three cylinder stats |

**Heat Pump Enable.** Grant DOC 0203: *"Enabling [Heat Pump Lock] will open the Volt Free switch
in Terminals 23 & 24 to disable heat pump demands"* — so closed contacts are the running
state, and the heat pump is locked by the **absence** of a signal. The Shelly is
normally-open only and cannot be rewired for a changeover contact, so an unpowered relay
locks the heat pump out. Nothing is wired to its input.

**Boiler Release.** Takes the Grant back-up heater output as its switch input and
gives a volt-free contact to the Fröling boiler release. The Fröling is set to raise the
buffer to 70 °C, so closing this relay is permission to burn, never a command — the boiler
decides for itself whether it fires.

**DHW Enable.** Can pass the time clock through, block it, or close independently of it. The
three cylinder stats downstream decide whether heat actually moves.

---

## Interaction with the power system

- The heat pump runs on the house supply like any other load. It is not surplus-gated, and
  the only reason to disable it is a prolonged shortage of power — see
  [CONTROLS.md](CONTROLS.md).
- When it runs, its ΔT-modulated pump **mixes the buffer**, degrading the stratification that
  `thermal-dump-controller.js` depends on to recover the buffer immersions from thermal
  cutout. Worth watching when both run together.
- The heat loop pump runs continuously at low flow temperatures and also mixes the buffer.
  Options discussed: a ΔT pump on the heat loop, or removing the plate heat exchanger and
  adding a strainer on the radiator return.
- Heat pump consumption is metered by a Shelly Pro 3EM and reaches the Cerbo as an AC load,
  so it is visible in VRM and to any script — see [POWER.md](POWER.md).

---

## Commissioning record

From the Air Source Heat Pump Report, 24 July 2026 (test reference REN-003505-23072026).

Commissioned on heat curve 0.6 (now 1.1), max flow 65 °C, heat stop 16 °C. Auxiliary
heater declared as biomass, 50 kW, bivalent point −1 °C. DHW recorded as third party —
cylinder thermostat and programmer, 55 °C start, 60 °C stop — with no legionella cycle
configured. System water untreated, cleaned with MC3 per BS7593. Everything else
(pressures, clearances, warranties, certificates) is in the pack itself.

---

## Current settings

ecoNET, 28 August 2026 — device `243EDPN6KQ38CIH2S02K018`.

| | |
|---|---|
| Hydraulic scheme | Buffer, two sensors |
| Buffer preset / hysteresis | 35 °C / 2 °C |
| Heating installation start / stop hyst. | 25 °C / 2 °C |
| External temp. sensor | YES, source `ecoMULTI` (the Smart Controller's own wired sensor) |
| Summer / winter mode activation | 16 °C / 15 °C |
| Heat source schedule | 24/7, all days |
| Cooling support | NO |

Per-circuit setpoints and regulation are in [Zones](#zones) above. Additional service
values: circuit 2 decrease 3 °C, min 24 °C, max 75 °C, valve opening 120 s, mixer
insensitiveness 1.0 °C, proportionality 3.0, integral 160.0; circuits 1 and 3 decrease
2 °C, room correction 0.0, and circuit 3 is capped at 45 °C.

---

## Outstanding work and known issues

Plant issues only. Controller work is in [CONTROLS.md](CONTROLS.md); device and metering
issues are in [POWER.md](POWER.md).

| Item | Status |
|---|---|
| Altitude correction to the design temperature | Certificate says −5.4 °C; at ~370 m the MCS rule gives −7.2 °C, so the 17.7 kW heat loss is understated |
| Towel rails on the DHW circuit | Plumbed onto DHW rather than the radiator circuit, so they run at cylinder temperature outside the weather-compensated zone |
| Heat loop pump mixing the buffer | ΔT pump, or remove the plate heat exchanger |
| Living 1 and Kitchen 3 radiators undersized at 45 °C | Accepted on stove and cooking gains; upgrade if they struggle |

## References

In `Blackhouse Lodge/Energy/Heat Pump`:

- `REN-003505 … Complete Handover Pack.pdf` — commissioning report, heat loss, compliance
  and MCS certificates, warranties. The authoritative record.
- `RH1663 Muttonhall Design Notes.docx` and `RH1663 Muttonhall Design.pdf` — options
  appraisal, sizing, buffer autonomy working
- `RH1663 Rad sizing.pdf` — room-by-room emitter schedule at 45 °C
- `Quote_No_1722 rev1.pdf`, `Invoice_No_13776.pdf` — as-quoted vs as-invoiced
- `BLACKHOUSE LODG SELKIRK - LEVEL 01.pdf` — survey floor plan
- `Installation Photos/` — plant room, buffer shed, atrium cupboard as-built

In `docs/`: Grant DOC 0203 (Smart Controller — terminals, heat pump lock, back-up heater,
AHS) and the Aerona 290 installation instructions.

In `~/dbus-froeling`: the Lambdatronic 3200 Modbus map
(`B1200522_ModBus Lambdatronic 3200_50-04_05-19_de.pdf`) and the bridge that publishes
buffer top, buffer bottom and furnace status to the Cerbo. Register offsets there are
counted from 30001, so buffer top (32001) is offset 2000 and boiler flow (30001) is
offset 0.

Monitoring: [ecoNET](https://www.econet24.com/view/device/243EDPN6KQ38CIH2S02K018/main/),
Victron VRM, emoncms MyHeatpump.

Correspondence: the Muttonhall thread with Renewable Heat, Sep 2025 – May 2026. The
outstanding-works list of 9 May 2026 and the snag list of 13 May 2026 are the most useful
single messages.
