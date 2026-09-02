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
| [CONTEXT.md](CONTEXT.md) | The vocabulary every document here uses |
| [docs/adr/](docs/adr) | One decision each: what was chosen, what was rejected, and what that cost |

**Status.** The dump load side is live and has been for months. On the heating side the
heat pump lock is written, and the immersions shed with it; the other two relays are not.

| Behaviour | State |
|---|---|
| DHW immersions on SOC thresholds, with a manual time switch | Live |
| Buffer immersions tracking surplus | Live |
| Thermal recovery from stalled buffer immersions | Live |
| Shortage, the heat pump lock and the immersions shedding with it | Written, not yet deployed |
| Biomass release, DHW enable | **Designed only** |

---

## Shortage

Neither the Cerbo nor a Shelly script keeps history, so anything needing rolling averages or
forecasts is out. That is no real loss: battery SOC is the integral of generation minus
consumption, so it already contains the energy balance. Rate of change, cumulative deficit
and "the generator ran" are the same signal read differently.

So there is one state — **shortage** — and it is a function of three readings, not a state
machine with a history:

| Term | |
|---|---|
| VE.Bus | Anything other than Inverting (9) is shortage, whatever the latch says |
| SOC at or below **30%** | Latch on |
| SOC at or above **90%** | Latch off |
| Between the two | The latch holds |
| A controller that has never resolved its latch | Shortage, until generation exceeds **500 W** |
| Unknown or stale VE.Bus state | Counts as not inverting |
| No reading yet, within three minutes of starting | Counts as nothing: no action either way |

**The latch is not an implementation detail — it is what stops the system cycling.** The
loads shortage sheds are the same loads that move SOC, so a rule reading only the present
would shed at 30%, watch the battery recover to 31% on the load it had just dropped,
un-shed, and be back at 30% a quarter of an hour later. At 1.5 kW of hydro against a 3 kW
heat pump that is a 40-minute cycle, all day, and the immersions join it whenever the time
switch is calling. The 60-point band is wide for exactly this reason.

**The latch lives on .209, and its durable copy is the relay contact.** The contact survives
a script restart, and the switch's last-command source tells that apart from an untouched
contact, where the relay is only `initial_state: "on"`: nothing but a command moves it, so a
source of `init` is a configuration default rather than a decision. So a redeploy does not
discard what the relay already knew, and a script deployed hours into a boot does not read a
default as a released heat pump.

On a genuinely fresh boot between the thresholds, generation supplies the initial value: the
controller cannot know which way the battery was going, so it assumes shortage — the safe
end — and clears when it sees more than 500 W of hydro or solar. See
[ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md).

Shortage is the safe assumption because of what a mid-band state of charge with no renewable
generation actually is: a significantly degraded system, where the generator is starting
periodically to top the battery up for the house. Between those runs VE.Bus is back to
Inverting and SOC sits somewhere in the band, so no instantaneous term catches it. The
assumption is the only thing standing between a fresh boot and a 3–5 kW heat pump running on
diesel.

**There are no dwell timers.** A year of logged SOC replayed against these thresholds gives
under five relay operations a day, decades inside the relay's rating. The VE.Bus term does
not chatter either — 31 excursions in 184 days, median 12 minutes, none oscillating. A dwell
would be the wrong tool for the cycling above in any case: a 30-minute hold makes that cycle
*shorter*, not longer.

An absent reading is not a stale one. The controller polls immediately on start, before
MQTT has connected, so a gate that locked on the state it had not received yet would lock
the heat pump on every redeploy — for a reading that arrives seconds later. The
grace covers only the case of never having had a reading, and is not restored by a broker
dropping later: once a state has been seen, silence is trouble again immediately. Three
minutes, because after a site-wide outage the Cerbo starts booting well after the Shelly
has finished. Without it, every redeploy would lock the heat pump and shed four immersions
for the second or two before the first reading landed.

### Why VE.Bus state, rather than "the generator is running"

If the relays are powered and the inverter is *not* running nominally off-grid, something is
being covered for: a generator on either AC input, a fault, an external override, a
passthrough. All of it says the same thing — limit consumption. State 9 is the only state in
which this system is doing what it normally does, so everything else is shortage.

This is also the gate `soc-relay-controller.js` already applies to the dump loads, so the
heating relays inherit a rule that is proven rather than inventing a second notion of
trouble. It costs no extra subscription — `vebus/276/State` is already in the topic set —
and it removes any need to read the generator service or enumerate its condition codes.

The logs bear this out from the other side: on two occasions the Cerbo held the generator
start relay closed for an hour or more with no AC input ever appearing — a start that
failed, not a run. VE.Bus stayed Inverting throughout, so this design saw nothing to react
to, while a rule written on the generator service would have called it a shortage.

It also means inverter overload reaches the heat pump without anyone writing code for it:
sustained overload starts the generator, the generator takes VE.Bus out of Inverting, and
the heat pump locks.

### Why 30%

Ten points above the generator's 20% autostart, which at a realistic deficit is around an
hour. An hour is enough, because the heat pump lock is instantaneous and the biomass makes
heat in 10–15 minutes. Below this the answer is the same whatever is coming in: there is not
enough time left to find out whether generation would have caught up.

### Why 90%

The generator stops charging at 80%, so above 90% the battery cannot have got there on
diesel. Nothing above that point needs a second opinion.

Between the two, the latch holds, and only a controller that has never resolved one asks
generation. That question — "is anything meaningfully coming in" — is the same one the
90% threshold answers by proxy, inferred from a diesel run stopping at 80%; reading the
meters answers it directly and immediately, which is what a fresh boot needs.

Keeping the VE.Bus term outside the latch fixes a case the old design left unhandled: a
generator run or a passthrough that clears while SOC sits mid-band used to leave the heat
pump locked until the battery next reached 90%, and now returns the system to whatever the
latch already said.

### Shedding is not the same as making heat

Shedding load is instant, cheap and reversible. Lighting a boiler is none of those things,
so the two consequences of shortage do not share a trigger:

| Action | Condition |
|---|---|
| Lock the heat pump, shed the DHW immersions and their timers | Shortage — immediately, no exemption |
| Release the biomass | `SOC < 30%`, or shortage sustained **30 minutes** on the VE.Bus term |

Thirty minutes clears the fortnightly generator test run — 20 minutes minimum runtime —
without knowing anything about generators at all. It also covers every other transient: a
brief passthrough, a fault that clears, an overload start.

The SOC term keeps its fast path deliberately. In a real shortage the boiler is released at
30%, well before the generator starts at 20%, so the delay only ever applies to the VE.Bus
term, where nothing is lost by waiting.

A shortage a controller assumed at startup, and has not yet cleared, is a third case: it
means nobody knows, not that anything is wrong. It waits the same 30 minutes as the VE.Bus
term, since the first generation reading above 500 W settles it.

---

## Who decides, and how the decision travels

**Heat Pump Enable (.209) determines shortage.** The device whose entire job is "am I
allowed to run" decides whether it is allowed to run. It subscribes to SOC, VE.Bus state and
both generation figures, applies the terms above, and switches its own relay — which is the
Grant's heat pump lock, so the decision and its primary consequence are the same action.

**The relay is the shortage state, expressed physically.** Everything else observes it over
MQTT at `shelly1minig3-d885ac0a3668/status/switch:0`: relay closed means the heat pump is
running, relay open means shortage. No retained flag, no second copy of a threshold.

| Follower | Reads | Does |
|---|---|---|
| DHW immersions (.88 .90 .91 .100) | .209's switch status | Sheds, time switch included, while it is open |
| Boiler Release (.164) | .209's switch status, plus `vebus/276/State` | Releases the boiler on sustained shortage |
| DHW Enable (.123) | .209's switch status | Opens a shortage DHW window |

**What travels is the lock, not shortage.** A follower asks "is the heat pump running", which
is what it actually wants to know: the biomass supplements when the heat pump is not running,
and DHW comes from the buffer when the heat pump cannot make it. That keeps the heating side
out of the power system entirely — the shortage rule needs four Victron subscriptions, and
.123 would have reached eight of Shelly's ten carrying them, for a script whose job is moving
heat between vessels.

It also makes manual control a first-class operation. Stop .209's script, put its relay where
you want it, and the biomass and DHW relays follow. Nothing recomputes around you.

.164 needs to distinguish the two terms — release now on a battery shortage, wait 30 minutes
on a VE.Bus one — and infers the cause rather than holding a threshold:

| .209 relay | VE.Bus | .164 concludes |
|---|---|---|
| Open | Inverting (9) | Must be the SOC term — release now |
| Open | Anything else | Could be transient — wait 30 minutes |

With no dwell on .209 the inference is exact, give or take one 30-second poll, so .164 needs
only a token dwell to cover that and no VE.Bus history of its own.

The 30, 90 and 500 W numbers therefore exist in exactly one deployment, on one device.

Every follower picks up the current value at startup by publishing `status_update` to
.209's command topic, which makes it republish on the status topic the follower already
subscribes to. A follower that never hears an answer sheds nothing: an undeployed or
unreachable .209 costs the immersion floor and nothing else, and every follower keeps its
own gates beneath it.

---

## What each actuator does

| Actuator | Rule |
|---|---|
| Heat Pump Enable (.209) | Closed unless in shortage |
| DHW immersions (`soc-relay-controller.js`) | Shed while the lock is open, time switch included; otherwise the surplus-SOC behaviour |
| Buffer immersions (`surplus-dump-controller.js`) | Surplus tracking across three constant stages and the dimmer |
| Boiler Release (.164) | Released on sustained shortage, **or** H1, **or** DHW demand, **or** exercise |
| DHW Enable (.123) | The time clock, unconditionally; **or** a shortage DHW window |

The biomass and the heat pump are inverses **only on the shortage term**. The Grant's H1
back-up heater request must stay independent: that is the winter bivalent, where at −1 °C the
biomass supplements a heat pump that is still running. Wiring them as strict inverses
silently disables the behaviour the system was commissioned for.

Once released, the boiler needs no burn scheduling. It has its own 70 °C buffer target and
stops when the buffer is charged, so releasing a boiler that has nothing to do is free and
nothing here second-guesses it. Roughly an hour per burn: 1500 L from 40 to 70 °C is ~52 kWh
of heat, displacing ~16 kWh of electricity at CoP 3.3.

**The floor holds against the time switch on a generator run too.** A generator start takes
VE.Bus out of Inverting, which is a shortage term, so the lock opens and the immersions shed
even where the time switch is asking. Today they would run: the VE.Bus gate sits below the
time switch in the ladder and never sees a calling clock. Honouring the whole lock rather
than just its battery term is the simpler rule — one boolean, one reading — and it keeps the
escape hatch in one place: stop .209's script and put its relay where you want it, and the
heat pump and the immersions are released together. Stopping it first is the whole hatch —
a running script re-asserts the latch on its next poll, so a contact closed by hand under it
is turned back within thirty seconds. The cost is up to 2.7 kW less load on a genset that is
running anyway, which may lengthen a run.

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
threshold — 96/95 on .88, 94/93 on .90, 95/94 on .91, 96/95 on .100 — so they stagger
rather than all switching at once as SOC crosses the band.
Each checks that generation exceeds 500 W before enabling, so a dump is never *started* out
of the battery when renewables are short, and checks inverter headroom before adding its
2.7 kW. Turn-off is purely SOC and waits out no dwell: once the low threshold is crossed,
2.7 kW comes off the inverter at once. The lead relay (.90) carries a manual time switch on
its input for intentional water heating; the others follow it over MQTT.

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
boiler is operating, and equally while it has yet to hear whether the boiler is operating:
dumping heat is a power system optimisation, and burning wood to feed a fan coil is the one
outcome worth a few seconds of inhibition at startup to avoid.

**Overload risk, still open.** The surplus controller enforces an inverter contribution limit
for its own loads, and each DHW immersion controller has a generation gate and a headroom
check, but the two operate independently. With several dump loads active on high generation
that then drops away — a hydro trip — the combined load plus house consumption can exceed
inverter capacity until loads cycle off on SOC hysteresis. The heat pump does not add to this
risk directly, since it is not gated on surplus, but it is 3–5 kW of the house load the
calculation starts from — prioritising the heat pump over any dumps/immersions is correct.

**Shedding happens on the edge; releasing waits for a poll.** The immersion stagger is a
property of SOC *crossing* four thresholds a point apart. Where all four are already
satisfied — anywhere above 96% — it does nothing, so the lock closing would release every
immersion in the same instant, each deciding against an inverter reading that predates its
peers' load: four relays, up to 10.8 kW, and every headroom check blind to what the others
just did. The lock introduced that case, because before it the only way in was a threshold
crossing, which is inherently ordered.

The two directions are not equally urgent, so they are not treated equally. A lock opening
sheds on the edge — that is the safety direction and waits for nothing. A lock closing is
recorded and left to the relay's own poll, and the polls are spaced across the interval:

| Tank | Offset |
|---|---|
| Left (.88, .90) | 0 s |
| Right (.91) | 10 s |
| Annex (.100) | 20 s |
| Heat Pump Enable (.209) | 0 s — no dump load to space out, and the others wait on it |

Grouped by tank rather than by device, because that is what the loads are: the two left
elements share a slot, the top one sitting in the stratified layer where it almost never
calls, so the pair is one 2.7 kW load in practice. What has to be separated is left from
right from annex.

**Nothing is queued to make this work,** which is the point. The poll re-reads the whole
ladder rather than acting on an intention formed earlier, so a lock that opens again before
the poll comes round is simply a shed, with no pending enable to cancel and no way to close
a relay on stale intent. The gap is not a dwell — it holds no decision, it only sets when
the decision is taken — and what it buys is that each relay's headroom check sees the
previous relay's load. Worst case a release waits one full interval.

**A script start is deliberately not staggered.** A restart can find this relay closed with
the lock open, and that shed must not wait on an offset whose only job is to space out
enabling, so the first check runs at once and only the loop that follows it starts late. The
consequence is that starting four scripts together can still enable four relays together:
deploy them one at a time, or watch the inverter while you do.

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
- **A shortage DHW window is open.** In shortage the heat pump is locked and the immersion
  time switch is blocked, so the buffer is the only route to hot water. The controller runs
  the time clock the user would otherwise turn on by hand.

**Windows are one hour in six** — 05:00, 11:00, 17:00, 23:00, plus one on entering shortage.
Fixed times need no anchor to persist and survive a reboot; the entry window stops a shortage
beginning at 07:30 from waiting until noon. One in six rather than the two in twelve the
physical clock would use, because a window need not finish a charge: a partial one resumes six
hours later, and the annex cylinder is small enough that one shower empties it.

**Buffer temperature guards the window; it does not trigger it.** The cylinder stats know
nothing about the primary side, so a window on a cold buffer would circulate through the coils
and strip heat back out of the cylinders. A window therefore requires **buffer top or boiler
flow ≥ 60 °C**, whichever is higher. Both are needed: buffer top measures the energy actually
stored but lags ignition by 10–15 minutes, while boiler flow (Fröling register `30001`,
reaching Victron as `temperature/103`) is the earliest honest signal and matches the
hydraulics, but cools when the boiler stops even with 1500 litres of heat in the buffer.

**A window is a slot, not a start time.** The guard is checked throughout the hour, so a
boiler that lifts the buffer past 60 °C at 05:20 still gets a window. Once the enable has
closed within a slot it stays closed until the slot ends: otherwise a burn finishing
mid-window slams the zone valves shut, and a buffer hovering at 60 °C cycles three actuators.
That is one flag in RAM, cleared with the hour — no timer, no re-arm threshold, no hysteresis.
A late guard gets a short run, which is accepted.

**The time clock takes authority.** `Switch.Set` overrides `follow` until the next input edge,
so the controller reads its own input and never opens the enable while the clock is calling: a
window expiring at 06:00 must not cancel a request made at 05:30. The clock is unguarded — the
user asking for hot water is not second-guessed against a buffer reading.

**A DHW demand also releases the biomass, unconditionally — a window does not.** Demand is a
request for heat the system may not have, and the boiler answers it. A window exists because
the heat is already there; releasing the boiler on one would be asking for heat on the grounds
of having some.

**Nothing takes DHW from the buffer outside shortage.** The immersions make the same water
from the same surplus more directly, and the enable only permits: with the cylinders satisfied
it moves no energy and merely runs the heat loop pump, mixing the buffer that
`thermal-dump-controller.js` needs stratified.

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

**The DHW Enable cannot tell whether anything happened.** .123 has no metering, and .171 —
the only device downstream that knows a stat is calling — is not something to depend on. A
1PM in its place would meter the stat, valve and pump load and so see a completed charge.
Nothing in the control law wants it: a window ends because the hour ended. Worth fitting for
diagnostics, not for control.

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
it would be fiction; a locked compressor stays off for the Grant's own restart delay rather
than the seconds a shed dump load costs; and overload already reaches it through the VE.Bus
term. The dump loads keep both protections, because for them the numbers
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
| Heat Pump Enable (.209) | `detached`, `initial_state: "on"`, no `auto_on`/`auto_off` | Heat pump runs, which is what should happen with no script. Nothing is wired to its input, so `match_input` would lock the heat pump out on every power cycle. The script reads the latch back off this contact and trusts any command that moved it, so a device timer would be indistinguishable from a decision |
| Boiler Release (.164) | `follow`, `match_input` | H1 releases the boiler in hardware — the bivalent survives a dead script, which matters because the relay is normally-open and cannot be rewired for a changeover contact |
| DHW Enable (.123) | `follow`, `match_input` | The time clock passes straight through, exactly as before the Shelly existed |
| Buffer immersions (.65, .161) | `detached`, `initial_state: "off"` | Nothing dumps. `follow` would let an input edge override the controller, and 2.69 kW should not latch on at boot with no surplus behind it and no script yet running |
| DHW immersions (.88 .91 .100) | `detached`, `initial_state: "off"` | Nothing heats until a controller says so |
| DHW immersion lead relay (.90) | `follow`, `match_input` | The manual time switch still makes hot water with no script running at all |

A `Switch.Set` overrides `follow` until the next input edge, so a script can hold .164, .123
or the lead relay closed for its own reasons without giving up the hardware path.

---

## Implementation plan

| Script | Device | Derived from | Job | State |
|---|---|---|---|---|
| `soc-relay-controller.js` | .209 | existing, reconfigured | Express shortage on its relay; no dump load gates | Written |
| `soc-relay-controller.js` | .88 .90 .91 .100 | existing | Follow .209's switch status; shed while it is open, time switch included | Written |
| `heating-relay-controller.js` | .164 | new | Sustained shortage from .209 and VE.Bus; H1; DHW demand; exercise run | To do |
| `dhw-controller.js` | .123 | `thermal-dump-controller.js` | Shortage DHW windows; derived for its buffer-temperature subscriptions, which gain boiler flow and .209's switch status | To do |

.209 runs the same file as the four DHW immersions. They share the shortage rule, and above
it the proven MQTT, keepalive and re-entrancy code, so one file is the honest arrangement:
what differs is a row in a table, not a program.

**The row is matched on the device ID at startup**, because `deploy.py` uploads one file
unaltered. `shortageLead: true` drops all three dump-load gates —
`minGenerationPower: 0` for the generation gate, `inverter.heaterPower: 0` for the headroom
check and the overload fast-path, and `followTimeSwitch: false` so neither its own input nor
the lead relay's can unlock the heat pump — and gives it no SOC band of its own, since its
relay is the shortage terms rather than a dump load's threshold.

**No threshold is exposed on any device.** Every relay's numbers live in one table in the
file, matched on the ID the device reports at startup. They are properties of the system
rather than preferences — the immersion stagger exists so that four 2.7 kW loads come on in
turn, and the shortage band is a fact about the generator and the batteries — so a slider
would be a knob for something nobody should turn. It would also drift: component `202` is
shared with the old `smart-load-controller.js` and stops at 50, so on .209 it can neither
express the 30% entry nor be trusted not to carry a stale value, and on the immersions it
put the documented stagger on the devices in one place and in this document in another,
where the two had already disagreed about .90 and .91. A persisted component left behind by
either script is now ignored rather than read. Immersions still derive their low threshold
as `high - 1`; only a band too wide to derive is stated outright.

The identity is read before anything else runs, and a device the table does not list runs
nothing at all: the controller commands nothing, which leaves the relay in the unscripted
behaviour the configuration table above guarantees — where guessing would have run .209 as
an immersion, locked below 95% and shed by the overload path.

The script asserts `status_ntf` in the device's MQTT config. Every follower reads .209's
published switch status, and the immersions read the lead relay's input, so a device with
status notifications off is a controller whose decision never leaves it.

The Victron broker behaves the same way, and worse for a value that rarely changes: it
publishes nothing until a value changes, and the one chance at the rest is the republish an
empty-payload keepalive triggers. That request has to come from a later turn of the script's
main loop than the subscriptions do, because `MQTT.subscribe` is only acted on once the
script yields: asked for in the same breath, the burst is answered before anything is
listening. So the first request goes out on a timer — the length is immaterial, a
millisecond would do, and the constant is 1 s — and the periodic keepalive keeps asking
until the value has actually been seen, which is what covers a request or a burst going
missing.

Two paths in the site's set have nothing to publish between transitions, so a republish is
the only way a controller starting up between them ever sees one: `vebus/276/State`, which
changes when a generator runs, months apart, and `digitalinput/102/State`, which moves when
the boiler starts or stops firing — several times a day while it is lit, and not at all
through a spell with power to spare. Everything else — SOC, generation, inverter output,
tank temperatures — changes every few seconds and arrives regardless, so the fault lands on
exactly the two paths a gate depends on. Measured on the live broker over 70 seconds, with
the boiler cold: the tank temperatures arrived four times each and neither of those two
arrived at all. Observed on .209 on first deployment, 1 September 2026, which read
VE Off for three minutes while everything else streamed correctly.

Shelly status notifications are published on change and are **not** retained, so a script
that follows another device sees nothing until that device next changes state. Every
follower must therefore ask rather than assume. Publishing `status_update` to the followed
device's `<prefix>/command` topic makes it republish every component on `<prefix>/status/…`
— the topics the follower already holds — so asking costs no extra subscription and no HTTP.
The DHW immersions do this against the lead relay's input; .164 and .123 will do the same
against whatever they come to follow. Without it, a controller restarting during a hot water
window ignores the time switch until the clock next moves.

Shelly caps a script's MQTT subscriptions, and overrunning the cap stops the script outright
rather than degrading it — see [README.md](README.md) for the number and how to stay under
it. So the topic sets stay deliberately small: the immersions run seven — five Victron
paths, the lead relay's input and .209's switch — and .209 runs five. Following the lock
rather than deriving it is what keeps .164 at two and .123 at five; deriving it would have
cost each of them the four Victron paths the terms rest on.

### Prerequisites

- **Add register `30001`** (Kesseltemperatur, ÷2) to `dbus-froeling` as a third temperature
  service. Buffer top, buffer bottom and furnace status are already published; boiler flow is
  the one addition the DHW gate needs.
