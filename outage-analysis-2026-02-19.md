# Muttonhall Off-Grid System - Outage Analysis
## 18-19 February 2026

### System Configuration

- 2x Victron Quattro 48/10000/140-2x100 (single-phase parallel, VE.Bus)
- 5x BYD Premium LVL 15.4kWh batteries (77kWh nominal, 3 previously connected, 4th added on 18 Feb)
- 10kVA diesel genset on AC In 1
- AC-coupled generation: 2x 4kW SMA Sunny Boy (solar tracker), 1x 4kW SMA Sunny Boy (ground mount), 8-10kW hydro
- DC-coupled: <1kW backup hydro turbine
- Shelly-controlled dump loads: 4x immersion heaters (SOC-gated), 3x surplus dump loads (surplus-tracking)

### Summary

After connecting the 4th BYD LVL battery pack on 18 February, the system experienced three significant outage events over the following 24 hours. Analysis of VRM telemetry data and BYD BeConnect BMS logs identifies the root cause as SOC/capacity mismatch of the newly connected pack, compounded by a software issue in the dump load controllers that caused dangerous post-restart load surges.

---

### Event Timeline

#### Event 1: VE.Bus Off — 19 Feb 00:03:33 (4 seconds)

**Pre-event state:** System running normally at 98% SOC. Hydro generating ~7.9kW. Surplus dump controller absorbing excess via 3x 2.69kW dump loads (~8kW total dump).

**Sequence:**
1. 00:03:33 — VE.Bus state transitions to Off. Hydro trips offline (frequency excursion when inverter stops). All AC loads lose power.
2. 00:03:37 — VE.Bus transitions back to Inverting. Inverter output 0W, ramping up as house loads reconnect.
3. 00:04:01 — Battery discharge reaches -58A (-3085W). Hydro not yet resynchronised (PV output ~0W).
4. 00:06:22 — Battery discharge reaches -210A (-11kW). SOC drops to 97%.
5. 00:07:08 — Battery discharge peaks at **-248A (-12.9kW)**. Entire house load supplied from batteries with zero generation.
6. 00:08:21 — System stabilises. Dump loads confirmed off, battery returns to charging.

**Analysis:** The 12.9kW post-restart surge was caused entirely by non-metered house loads resuming (heating, hot water, etc.) while the hydro generator had not yet resynchronised. The Shelly dump load meters (AC Meters 50-58) all showed 0W when they came back online — the dump controllers were not responsible for this particular surge.

#### Event 2: VE.Bus Off — 19 Feb 00:14:25 (4 seconds)

**Pre-event state:** System recovering from Event 1. SOC 97%. Hydro still not fully online.

**Sequence:**
1. 00:14:25 — VE.Bus goes Off again.
2. 00:14:29 — VE.Bus transitions back to Inverting.
3. 00:16:38 — **Right immersion heater (M54) turns ON: 2623W** — dump-load-controller enabled it because SOC (97%) was above its 95% threshold.
4. 00:17:34 — **Left top immersion (M51) turns ON: 2534W** — SOC (97%) above its 96% threshold.
5. 00:17:50 — Right immersion turns off as SOC drops below threshold.
6. Battery discharge reached **-145A** (~7.5kW) during the surge.

**Analysis:** The dump-load-controllers contributed ~5.1kW to this surge. They enabled because SOC was above their thresholds, despite there being no meaningful generation to support the load. The controllers had no awareness of whether generation was available.

#### Event 3: VE.Bus Fault (Error 18) — 19 Feb 13:21:31 (12 minutes)

**Pre-event state:** SOC 98%, solar generating. System appeared stable.

**Sequence:**
1. 13:21:31 — VE.Bus enters **Fault** state (Error 18: AC overvoltage on slave unit). Inverters shut down.
2. 13:21:36 — Battery voltage spikes to 55.5V during fault condition.
3. 13:33:21 — VE.Bus transitions back to Inverting after 12-minute outage.
4. 13:33:43 — Battery discharge reaches -86A (-4.6kW). House base load, no generation yet.
5. 13:35:25 — **Right immersion (M54) turns ON: 2587W** — dump-load-controller, SOC 98% > threshold 95%.
6. 13:35:27 — **Annex immersion (M50) turns ON: 2615W** — dump-load-controller, SOC 98% > threshold 96%.
7. 13:38:30 — Battery discharge peaks at **-199.8A (-10.5kW)**. SOC drops to 97%.
8. 13:40:04 — Annex immersion turns off as SOC drops to its threshold.

**Analysis:** The dump-load-controllers contributed ~5.2kW to this surge, turning on within 2 minutes of the restart because SOC exceeded their thresholds. The hydro generator was still at 0W — all dump load power came from the batteries.

#### Event 4: Battery Pack Dropout — 19 Feb ~15:00

One BYD LVL pack dropped off the CAN bus. BMS logs show the pack going through power-on/power-off cycling, with a "BMS Firmware Update Failed" indication. Cell voltage spread on this pack was observed at 0.11V under load (3.21V to 3.52V), significantly wider than the normal 0.02-0.04V spread on the other packs.

---

### Root Cause Analysis

#### Primary: 4th Battery Pack SOC/Capacity Mismatch

The newly connected 4th BYD LVL pack had a significant state-of-charge and capacity mismatch relative to the existing 3 packs:

1. **Cell voltage imbalance under load:** The 4th pack showed a 0.11V spread (3.21V to 3.52V) compared to the normal 0.02-0.04V spread on established packs. This indicates cells within the pack are at different states of charge or have different capacities.

2. **Over-voltage risk:** The highest cell reached 3.52V, which is near the upper limit for LiFePO4 chemistry. During charging, mismatched cells reach dangerous voltages while others are still undercharged.

3. **BMS intervention:** The wide cell spread likely triggered the BMS to disconnect or limit the pack, causing sudden changes in available battery capacity that destabilised the system.

4. **Error 18 (AC overvoltage on slave):** This Victron fault occurs when the parallel slave inverter detects AC overvoltage. In an off-grid system, this typically indicates a sudden load rejection — if the BMS disconnects a pack mid-charge, the energy has to go somewhere, causing a voltage spike.

5. **Failed BMS firmware update:** The BeConnect logs show a failed firmware update on the 4th pack, which may have left the BMS in a degraded state.

#### Secondary: Dump Load Controller Software Issue

The immersion heater dump-load-controllers (4x Shelly devices) had a design flaw: they enabled based solely on SOC thresholds without checking whether generation was available. After each inverter restart:

- SOC remained high (97-98%)
- The controllers immediately turned on 2-3 immersion heaters (~5-8kW)
- No generation was available (hydro/solar takes time to resynchronise)
- All dump load power came from batteries, compounding the post-restart surge

This turned a ~5kW house load recovery into a 10-13kW battery discharge event.

---

### Corrective Actions Taken

#### Dump Load Controller Code Fixes (19-20 February)

Two changes were made to the immersion heater dump-load-controllers to prevent post-restart load surges:

1. **Generation gate** — The controllers now require at least 500W of total generation (AC-coupled solar/hydro + DC-coupled hydro) before enabling any dump load. This prevents the controllers from turning on when the system is running purely from batteries, regardless of SOC level.

2. **VE.Bus state gate** — The controllers now monitor the Victron VE.Bus state and only allow dump loads when the system is in **Inverting** mode (state 9). This is the only state indicating the inverter is running from battery/PV with no external AC input. All other states (Off, Fault, Passthru, Power Assist, Bulk, Absorption, Float, etc.) cause immediate suppression of all dump loads. This prevents loads enabling when:
   - The inverter is off or faulted
   - A generator is connected (Passthru/Power Assist)
   - The inverter is bypassed to a generator

The surplus dump controller (variable dimmer + 2x constant switches) was also updated with the VE.Bus state gate for consistency, though it was not responsible for the post-restart surges — its surplus calculation naturally prevents enabling when generation is zero.

---

### Recommendations

1. **4th battery pack:** The pack should be allowed to undergo several full charge/balance cycles with the existing packs before being relied upon. Monitor cell voltages via BeConnect during this period. If the 0.11V cell spread persists after balancing, the pack may need individual cell conditioning or replacement.

2. **BMS firmware:** Retry the failed firmware update on the 4th pack's BMS once the pack has been stabilised.

3. **Monitor post-fix behaviour:** The generation gate and VE.Bus state gate should prevent future dump load surges after restarts. Monitor the system during the next few charge/discharge cycles to confirm.

4. **Consider house load management:** The bulk of the post-restart current surge (~7-8kW of the 13kW peak) was from non-metered house loads, not dump loads. If post-restart surges remain a concern, consider whether any large house loads (e.g., underfloor heating, hot water immersion on house circuit) could be on contactors that delay restart.
