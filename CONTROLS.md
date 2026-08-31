# Muttonhall Control Strategy

How the site behaves as a system: when surplus is dumped, when the heat pump is allowed to
run, when the biomass is released, and how hot water gets made. This is the layer that
couples the power system to the heating plant, and it is owned by neither.

The division of labour across the documentation:

| Document | Owns |
|---|---|
| [README.md](README.md) | Each script — what it does, how it is configured and deployed |
| [POWER.md](POWER.md) | The electrical installation and the device inventory |
| [HEATING.md](HEATING.md) | The heating plant — hydraulics, zones, wiring, commissioning |
| **CONTROLS.md** | The system — states, thresholds, who decides what, and why |
| [CONTEXT.md](CONTEXT.md) | The vocabulary all four use |

**Status.** The dump load side is live and has been for months. The heating side is designed
and not yet implemented: no controller JavaScript exists for the three heating relays.

| Behaviour | State |
|---|---|
| DHW immersions on SOC thresholds, with a manual time switch | Live |
| Buffer immersions tracking surplus | Live |
| Thermal recovery from stalled buffer immersions | Live |
| Shortage, heat pump lock, biomass release, DHW enable | **Designed only** |

---

## Shortage

Neither the Cerbo nor a Shelly script keeps history, so anything needing rolling averages or
forecasts is out. That is no real loss: battery SOC is the integral of generation minus
consumption, so it already contains the energy balance. Rate of change, cumulative deficit
and "the generator ran" are the same signal read differently.

So there is one state — **shortage** — on two terms:

| | |
|---|---|
| Enter | SOC below **30%**, or VE.Bus state is anything other than Inverting (9) |
| Leave | SOC above **90%** and VE.Bus back to Inverting |
| Unknown or stale VE.Bus state | Counts as not inverting |
| Minimum lock | 30 minutes once the heat pump has been locked |

The band is 60 points wide — some 28 kWh across the three batteries currently connected — so
the SOC term cannot chatter and needs no dwell timer. The minimum lock is for the
compressor, not the logic: the heat pump should not be cycled by a transient.

### Why VE.Bus state, rather than "the generator is running"

If the relays are powered and the inverter is *not* running nominally off-grid, something is
being covered for: a generator on either AC input, a fault, an external override, a
passthrough. All of it says the same thing — limit consumption. State 9 is the only state in
which this system is doing what it normally does, so everything else is shortage.

This is also the gate `dump-load-controller.js` already applies to the dump loads, so the
heating relays inherit a rule that is proven rather than inventing a second notion of
trouble. It costs no extra subscription — `vebus/276/State` is already in the topic set —
and it removes any need to read the generator service or enumerate its condition codes.

It also means inverter overload reaches the heat pump without anyone writing code for it:
sustained overload starts the generator, the generator takes VE.Bus out of Inverting, and
the heat pump locks.

### Why 30% to enter

Ten points above the generator's 20% autostart, which at a realistic deficit is around an
hour. An hour is enough, because the heat pump lock is instantaneous and the biomass makes
heat in 10–15 minutes. Either the generation is sufficient to catch up once the heat pump is
off, or it is not; nothing in between needs a wider margin.

### Why 90% to leave

The generator stops charging at 80%, so **the last ten points can only come from hydro or
solar**. The exit condition is therefore a test for "renewables are actually back" that a
diesel run cannot fake.

Leaving at 80% instead would re-enable a 3–5 kW heat pump onto a battery the generator had
just filled, with no generation behind it: back to 20% within the day, two or three diesel
starts every day of the winter, which is the outcome the biomass exists to prevent.

### Shedding is not the same as making heat

Shedding load is instant, cheap and reversible. Lighting a boiler is none of those things,
so the two consequences of shortage do not share a trigger:

| Action | Condition |
|---|---|
| Lock the heat pump, block DHW immersion timers | Shortage — immediately, no exemption |
| Release the biomass | `SOC < 30%`, or shortage sustained **30 minutes** on the VE.Bus term |

Thirty minutes clears the fortnightly generator test run — 20 minutes of running plus a
20-minute minimum runtime — without knowing anything about generators at all. It also covers
every other transient: a brief passthrough, a fault that clears, an overload start.

The SOC term keeps its fast path deliberately. In a real shortage the boiler is released at
30%, well before the generator starts at 20%, so the delay only ever applies to the VE.Bus
term, where nothing is lost by waiting.

---

## Who decides, and how the decision travels

**Heat Pump Enable (.209) determines shortage.** The device whose entire job is "am I allowed to
run" decides whether it is allowed to run. It subscribes to SOC and VE.Bus state, applies
the thresholds above, and switches its own relay — which is the Grant's heat pump lock, so
the decision and its primary consequence are the same action.

**The relay is the shortage state, expressed physically.** Everything else observes it over
MQTT at `shelly1minig3-d885ac0a3668/status/switch:0`: relay closed means running, relay open
means shortage. No retained flag, no staleness question, no second copy of a threshold.

| Follower | Reads | Does |
|---|---|---|
| DHW immersions (.88 .90 .91 .100) | .209 switch status | Blocks time-switch propagation while open |
| Boiler Release (.164) | .209 switch status, plus `vebus/276/State` | Releases the boiler on sustained shortage |

.164 needs to distinguish the two terms — release now on a battery shortage, wait 30 minutes
on a VE.Bus one — and infers the cause rather than holding a threshold:

| .209 relay | VE.Bus | .164 concludes |
|---|---|---|
| Open | Inverting (9) | Must be the SOC term — release now |
| Open | Anything else | Could be transient — wait 30 minutes |

The 30% and 90% numbers therefore exist in exactly one deployment, on one device.

A manual lock of the heat pump for maintenance also blocks timed immersion heating, which is
the right answer anyway: someone has declared the site short of power.

---

## What each actuator does

| Actuator | Rule |
|---|---|
| Heat Pump Enable (.209) | Closed unless in shortage; 30-minute minimum lock |
| DHW immersions (`dump-load-controller.js`) | Existing surplus-SOC behaviour, plus a floor: time switch propagation blocked while .209 is open |
| Buffer immersions (`surplus-dump-controller.js`) | Surplus tracking across three constant stages and the dimmer |
| Boiler Release (.164) | Released on sustained shortage, **or** H1, **or** DHW demand, **or** exercise |
| DHW Enable (.123) | Timer **or** opportunistic; never a function of shortage |

The biomass and the heat pump are inverses **only on the shortage term**. The Grant's H1
back-up heater request must stay independent: that is the winter bivalent, where at −1 °C the
biomass supplements a heat pump that is still running. Wiring them as strict inverses
silently disables the behaviour the system was commissioned for.

Once released, the boiler needs no burn scheduling. It has its own 70 °C buffer target and
stops when the buffer is charged, so releasing a boiler that has nothing to do is free and
nothing here second-guesses it. Roughly an hour per burn: 1500 L from 40 to 70 °C is ~52 kWh
of heat, displacing ~16 kWh of electricity at CoP 3.3.

**The lead relay's hardware follow fights the shortage floor, briefly.** 192.168.1.90 is
`in_mode: "follow"`, so the time switch closes it in hardware and the script has to turn it
back off — within one 30-second poll. Because a `Switch.Set` overrides follow until the next
input edge, it then stays off for the rest of the window. The cost is up to 30 seconds of one
immersion, twice a day, only in shortage: cheaper than losing the property that the time
switch still makes hot water with no script running at all.

---

## Dump loads today

Live behaviour, for context. Per-script detail is in [README.md](README.md).

**DHW immersions** — four 1PM devices, each enabling its immersion above its own SOC
threshold (96/95, 95/94, 94/93, 96/95) so they stagger rather than all switching at once.
Each checks that total generation exceeds 500 W before enabling, so a full-reading battery at
night cannot start a dump, and checks inverter headroom before adding its 2.7 kW. Turn-off is
purely SOC and minimum-on-time, so generation dropping away mid-cycle does not cause rapid
cycling. The lead relay (.90) carries a manual time switch on its input for intentional water
heating; the others follow it over MQTT.

**Buffer immersions** — `surplus-dump-controller.js` on the dimmer allocates surplus
sequentially across the two Pro 2PM channels, the Pro 1PM carrying immersion 4, and its
own 0–10 V stage, using *intended*
rather than measured dump power to avoid feedback loops, with 150 W hysteresis and a 12 kW
inverter contribution limit. Above 97% SOC it enables loads regardless of measured surplus.
It reserves headroom for the EVSE when the EV charger is in auto mode rather than fighting the
EVSE's own surplus algorithm.

**Thermal recovery** — `thermal-dump-controller.js` detects the buffer immersions' thermal
cutouts (output on, voltage present, no power), then runs the garage fan coil and a
circulation pump to stir the buffer and bring them back. It suppresses itself while the
boiler is operating.

**Overload risk, still open.** The surplus controller enforces an inverter contribution limit
for its own loads, and each DHW immersion controller has a generation gate and a headroom
check, but the two operate independently. With several dump loads active on high generation
that then drops away — a hydro trip — the combined load plus house consumption can exceed
inverter capacity until loads cycle off on SOC hysteresis. The heat pump does not add to this
risk directly, since it is not gated on surplus, but it is 3–5 kW of the house load the
calculation starts from.

---

## DHW

**DHW demand** is a request for hot water: the time clock calling, or heat that happens to be
available. **DHW enable** is permission for heat to move from the buffer into the cylinders.
Demand asks, enable permits, and the three cylinder thermostats decide whether anything
actually moves — which is why nothing here needs to sense cylinder temperature. Close the
enable and a cool cylinder loads itself; a hot one does nothing.

DHW Enable closes when **either**:

- **The timer is on** — unconditionally, with no reference to buffer temperature, boiler
  state, shortage, or anything arriving over MQTT. The switch says heat, so: heat. This path
  must keep working when the Cerbo is down, the Fröling data is stale or the network is
  broken, because it is the user physically asking for hot water. In normal operation the
  timer is off; it exists so it can be flipped to timed or permanent-on and behave as
  expected, making hot water with the biomass.
- **Opportunistically**, when heat is already there: **buffer top ≥ 65 °C or boiler flow
  ≥ 65 °C**, for a fixed **90 minutes**. The cylinders take surplus heat out of the buffer
  whether it came from the buffer immersions or from the boiler, with no scheduling and no
  arbitration.

The opportunistic period is edge-triggered, not a level. It re-arms only once the gate has
fallen below 58 °C and risen again, or after 6 hours — so a persistently hot buffer gives
four opportunities a day and a single burn gives one clean run. Left as a level it would hold
the enable closed indefinitely, and every time a cylinder drifted from 60 back to 55 °C the
zone valve, the cylinder pump and the heat loop pump would all run again. That last one
matters: the heat loop pump mixes the buffer, and stratification is what
`thermal-dump-controller.js` relies on to recover the immersions from thermal cutout.

Both temperatures are needed because they fail in opposite directions. Buffer top measures
the energy actually stored and is the only signal that sees the immersion case, but it lags
ignition by 10–15 minutes. Boiler flow (Fröling register `30001`) is the earliest honest
signal and matches the hydraulics — flow reaches the house loop before the buffer charges,
since there is a pump pulling — but it goes cold the moment the boiler stops, even with 1500
litres of heat behind it.

A DHW demand also releases the biomass, unconditionally. If the buffer is already hot the
boiler does nothing with the release, which is the boiler's decision to make.

Nothing arbitrates between DHW and the heating circuits, since the Grant does not know DHW
exists. On a marginal buffer, let DHW win: cold water is noticed in hours, a slightly cooler
house is not.

---

## Exercise run

The Fröling needs to move periodically even when it is not needed for heat — augers, grates
and ignition free of tar and moisture. This matters *more* now the heat pump takes the bulk
of the heating load, because a boiler that would previously have run all winter may now sit
idle in exactly the damp conditions that cause the problem. The point is keeping warm and
giving every moving part the opportunity to move; the hopper cannot be emptied except by
digging or burning.

Fourteen days with no observed ignition releases the boiler. The release is held for one hour
after ignition, then dropped. The Fröling still self-gates on buffer temperature, so in
summer with the immersions holding the buffer at 75 °C the release may sit asserted for days
before anything happens — harmless, and no reason to build a second buffer control on top of
the one the boiler already has.

Last-ignition time lives in Shelly KVS, not RAM, or a reboot resets it. Seed it with the
current time on first run so a redeploy never triggers a burn.

---

## Deliberately absent

**No alerting.** The Fröling has its own remote monitoring, which is where boiler faults
belong. The Shelly scripts get no alerting responsibility at all.

**The immersions do not watch the boiler.** Tempting to lift the immersion block when the
boiler fails to deliver, but the hysteresis already handles it: in shortage the heat pump and
immersions are both off, so house load drops by several kW and SOC climbs on hydro alone
whether or not the boiler ever lit. At 90% the immersions come back by themselves. A jammed
hopper resolves as a slow return to electric heating, roughly a day, with cylinder storage
covering the gap.

**The EVSE is not shed on shortage.** Manual mode is the user's stated intent to charge the
car regardless of availability. Auto mode stops itself on its own surplus criteria, which are
at least as aggressive as these.

**No heat pump headroom check.** The heat pump is a load, not a dump. Its draw modulates
between roughly 0.5 and 5 kW and its meter is not on the Cerbo, so any constant reserved for
it would be fiction; a locked compressor stays off for the minimum lock plus the Grant's own
restart delay rather than the seconds a shed dump load costs; and overload already reaches it
through the VE.Bus term. The dump loads keep both protections, because for them the numbers
are real and the shed is free.

---

## Relay configuration

Each relay's *unscripted* behaviour should be whatever is sensible with no script running, so
that a stopped script or a fresh boot degrades predictably rather than to whatever the factory
default happens to be. For a relay inserted into existing controls, sensible means the
behaviour the system had before the Shelly was there. For a dump load, which exists only to
absorb surplus and has no prior behaviour to preserve, it means off.

| Relay | Configuration | Unscripted behaviour |
|---|---|---|
| Heat Pump Enable (.209) | `detached`, `initial_state: "on"` | Heat pump runs. Nothing is wired to its input, so `match_input` would lock the heat pump out on every power cycle |
| Boiler Release (.164) | `follow`, `match_input` | H1 releases the boiler in hardware — the bivalent survives a dead script, which matters because the relay is normally-open and cannot be rewired for a changeover contact |
| DHW Enable (.123) | `follow`, `match_input` | The time clock passes straight through, exactly as before the Shelly existed |
| Buffer immersions (.65, .161) | `detached`, `initial_state: "off"` | Nothing dumps. `follow` would let an input edge override the controller, and 2.69 kW should not latch on at boot with no surplus behind it and no script yet running |
| DHW immersions (.88 .91 .100) | `detached`, `initial_state: "off"` | Nothing heats until a controller says so |
| DHW immersion lead relay (.90) | `follow`, `match_input` | The manual time switch still makes hot water with no script running at all |

A `Switch.Set` overrides `follow` until the next input edge, so a script can hold .164, .123
or the lead relay closed for its own reasons without giving up the hardware path.

---

## Implementation plan

| Script | Device | Derived from | Job |
|---|---|---|---|
| `dump-load-controller.js` | .209 | existing, reconfigured | Determine shortage: 90% on, 30% off, VE.Bus gate, no generation gate, no headroom check |
| `dump-load-controller.js` | .88 .90 .91 .100 | existing | Follow .209's switch status; block time switch propagation in shortage |
| `heating-relay-controller.js` | .164 | new | Sustained shortage from .209 and VE.Bus; H1; DHW demand; exercise run |
| `dhw-controller.js` | .123 | `thermal-dump-controller.js` | Timer or opportunistic enable; it already subscribes to buffer temperatures and boiler status |
| `thermal-dump-controller.js` | .156 | existing | Watch buffer immersion 4 (.65) for thermal cutout alongside the other three stages |

Immersion 4 is switched by `surplus-dump-controller.js` but is not yet watched by
`thermal-dump-controller.js`, whose `dumpLoads` still lists only the two Pro 2PM channels
and the dimmer. Until it is, immersion 4 reaching its thermal cutout does not call for the
fan coil and circulation pump, so the buffer is not stirred and the immersion stays stalled
until something else trips. The surplus controller already keeps a stalled stage nominally
on without charging it against the surplus budget, so the load is not double-counted — the
gap is only in heat recovery. One entry in `config.dumpLoads` for
`shellypro1pm-5c013b056870/status/switch:0` closes it, and that device publishes on the
same status topic shape as the others.


.209 runs the same file as the four DHW immersions. Structurally it is the same controller —
relay on above a high SOC threshold, off below a low one, gated on VE.Bus state, with a
minimum time in state — so the proven MQTT, keepalive and re-entrancy code stays in one
place. Two small additions are needed:

- **Explicit `soc.lowThreshold`**, since it is currently derived as `highThreshold - 1` and
  cannot express 90/30.
- **`minOffTime`**, for the 30-minute minimum lock; the script has `minOnTime` only.

The rest is configuration that already exists: `minGenerationPower: 0` disables the
generation gate, `inverter.heaterPower: 0` disables the headroom check and emergency
fast-path, plus flags for lead-relay follow (off for .209) and for the shortage-source topic
the DHW immersions subscribe to.

Shelly status notifications are published on change and are **not** retained, so a script
that follows another device sees nothing until that device next changes state. Every
follower must therefore seed itself with an HTTP `Switch.GetStatus` against the device it
follows at startup: .164 and the four DHW immersions against .209, and the DHW immersions
against the lead relay's input. Without it, a controller restarting mid-shortage would
assume no shortage until the next transition.

Shelly caps a script's MQTT subscriptions, and overrunning the cap stops the script outright
rather than degrading it — see [README.md](README.md) for the number and how to stay under
it. So the topic sets stay deliberately small: the existing controllers run five or six each.
Defining shortage on VE.Bus state rather than on the generator service is part of what keeps
the heating relays clear of it.

### Prerequisites

- **Add register `30001`** (Kesseltemperatur, ÷2) to `dbus-froeling` as a third temperature
  service. Buffer top, buffer bottom and furnace status are already published; boiler flow is
  the one addition the DHW gate needs.
