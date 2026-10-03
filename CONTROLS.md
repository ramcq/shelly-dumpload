# Muttonhall Control Strategy

How the site behaves as a system: when surplus is dumped, when the heat pump is allowed to
run, when the biomass is released, and how hot water gets made. This is the layer that
couples the power system to the heating plant, and it is owned by neither.

Which document owns what is [README.md](README.md)'s table. What is running on a device is
`Script.List` on the device.

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
| No reading yet, within five minutes of starting | Counts as nothing: no action either way |

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
dropping later: once a state has been seen, silence is trouble again immediately. Five
minutes, because after a site-wide outage the Cerbo starts booting well after the Shelly
has finished: a Cerbo cold boot reaches MQTT in around two and a half minutes, where a
healthy one answers a republish in under a tenth of a second. The grace ends on the first
reading rather than when it expires, so its length costs nothing except where there is
nothing there to answer. Without it, every redeploy would lock the heat pump and shed four
immersions for the second or two before the first reading landed.

**The grace is measured against uptime, not the wall clock**, as is every other interval a
controller times within one run. A stamp taken before NTP lands and compared after it reads
as days, so the sync ends every interval stamped ahead of it — this grace among them, in
seconds: [ADR 0003](docs/adr/0003-elapsed-time-is-measured-against-uptime.md).

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
| Release the biomass | The lock open for **30 minutes** |

Thirty minutes clears the fortnightly generator test run (20 minutes minimum runtime, 22.6 in
practice) and other transients: a brief passthrough, a fault that clears, an overload start,
or a .209 restart that assumes shortage until it sees generation. A battery shortage waits
too: at 30% SOC the generator's 20% autostart is still about an hour away.

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
| Boiler Release (.164) | .209's switch status | Releases the boiler once it has been open 30 minutes |
| DHW Enable (.123) | .209's switch status | Opens a shortage DHW window |

**What travels is the lock, not shortage.** A follower asks "is the heat pump running", which
is what it actually wants to know: the biomass supplements when the heat pump is not running,
and DHW comes from the buffer when the heat pump cannot make it. That keeps the heating side
out of the power system entirely — the shortage rule needs four Victron subscriptions, and
.123 would have reached seven of Shelly's ten carrying them, for a script whose job is moving
heat between vessels.

It also makes manual control a first-class operation. Stop .209's script, put its relay where
you want it, and the biomass and DHW relays follow. Nothing recomputes around you.

The 30, 90 and 500 W numbers therefore exist in exactly one deployment, on one device.

**.209 runs the same file as the four DHW immersions.** They share the shortage rule, and
above it the proven MQTT, keepalive and re-entrancy code, so one file is the honest
arrangement: what differs is a row in a table, not a program. `deploy.py` uploads that file
unaltered, so the row is matched on the device ID at startup — `shortageLead: true` drops all
three dump-load gates and gives .209 no SOC band of its own, since its relay is the shortage
terms rather than a dump load's threshold. A device the table does not list runs nothing at
all, which leaves the relay in the unscripted behaviour the configuration table below
guarantees; guessing would have run .209 as an immersion, locked below 95% and shed by the
overload path.

Every follower picks up the current value at startup by publishing `status_update` to
.209's command topic, which makes it republish on the status topic the follower already
subscribes to. A follower that never hears an answer sheds nothing: an undeployed or
unreachable .209 costs the immersion floor and nothing else, and every follower keeps its
own gates beneath it.

**A broker drop is not the lock moving.** What a drop does to a follower's copy depends on
what the copy is for. Anything that may have moved unseen is cleared, so that it is unknown
afterwards rather than merely old: a cleared VE.Bus state is not inverting and sheds, a
cleared time switch is one that has stopped asking. The lock is kept instead — silence is not
.209 saying the battery recovered, forgetting it would shed four immersions on a blip, and the
reconnect asks for it again anyway.

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

How the dump loads behave together. What each script does on its own is in
[README.md](README.md).

**Each surplus stage holds its position for ten minutes, either way.** That is the one place on
this site where shedding a dump load waits, and it is not a safety rule: the allocator budgets
a stage at its nominal power, so it needs the stage to stand still long enough to be budgeted
against. A stage moving faster than its meter reads is one the next allocation counts wrong.

The floor under it is `minSurplus`: below 100 W of available power every stage goes off, lock
or no lock. That is less an exception than the point at which the rule stops applying.
Available already has the dumps' own draw added back, so falling under 100 W means generation
has dropped a full stage below what is running — the battery carrying the dumps, rather than
the threshold being grazed that the lock exists for.

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
recorded and left to the relay's own poll.

The manual time switch is the same shape and the busier case: the lead relay's input status
reaches the three followers in one instant, and the clock runs twice a day where the lock may
open a handful of times a year. Closing the clock can only enable, so it waits for the poll
too; opening it can shed, through the gates below the time switch in the ladder, so it keeps
the edge. Every other way in already waits, because the Victron readings — SOC, generation,
VE.Bus returning to Inverting — do not act when they arrive; they are acted on by the poll.

The polls are spaced across the interval:

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

**The slots are anchored to the clock, not to when a script started.** Start times do not
agree on where a window begins: deploy two relays twenty seconds apart with offsets ten
seconds apart and they land on the same tick, since it takes only start plus offset to come
out the same modulo the interval. So a relay waits for the moment the clock comes round to
its own slot and keeps it for as long as the script runs, whenever it happened to start. A
device with no synchronised clock has nothing shared to anchor to and falls back to
start-relative, which is worth something after a site-wide restart and nothing after a
staggered one.

The left tank holds offset 0 deliberately. Its lead relay answers the time switch in hardware
and its script waits for nothing, so closing the clock still produces an audible click in the
same room as the switch — which is the feedback someone standing there is entitled to. The
tanks that wait are the ones nobody is listening to.

**Nothing is queued to make this work,** which is the point. The poll re-reads the whole
ladder rather than acting on an intention formed earlier, so a lock that opens again before
the poll comes round is simply a shed, with no pending enable to cancel and no way to close
a relay on stale intent. The gap is not a dwell — it holds no decision, it only sets when
the decision is taken — and what it buys is that each relay's headroom check sees the
previous relay's load. Worst case a release waits one full interval.

**A script start is deliberately not staggered.** A restart can find this relay closed with
the lock open, and that shed must not wait on a slot whose only job is to space out
enabling, so the first check runs at once and only the loop that follows it waits. The
consequence is that starting four scripts together can still enable four relays together —
the slots govern every poll after the first, not the first. Deploy them one at a time, or
watch the inverter while you do; deploy order no longer disturbs the slots themselves.

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
Where neither can be read at all, the window runs without them — see
[When the Fröling bridge falls over](#when-the-fröling-bridge-falls-over).

**A window is a slot, not a start time.** The guard is checked throughout the hour, so a
boiler that lifts the buffer past 60 °C at 05:20 still gets a window. Once the enable has
closed within a slot it stays closed until the slot ends: otherwise a burn finishing
mid-window shuts the zone valves, and a buffer hovering at 60 °C cycles three actuators.
That is one flag in RAM, cleared with the hour — no timer, no re-arm threshold, no hysteresis.
A late guard gets a short run, which is accepted.

**Two windows that touch are one window.** An entry window running into 05:00 carries the
flag across, since the top of an hour a window was already open through is no reason to shut
the valves. Nothing chains beyond that: the flag is cleared whenever there is no window.

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

## When the Fröling bridge falls over

When `dbus-froeling` loses its Modbus connection it **holds the last value and sets
`/Connected` to 0** rather than invalidating the reading — deliberately, since a transient
error that showed the boiler stopping and restarting would read as an ignition.

So the value topics go quiet holding a number that still looks fresh, and every controller
that reads a Fröling path reads `/Connected` too, at the point of use rather than as an
event: a controller that merely forgot its reading would take the next republish burst for a
fresh one, the more certainly for being what asked for the burst. One path answers for all
four services, which share a Modbus client and fail together, and it is a silent signal, so
it is asked for with the keepalive like `vebus/276/State` beside it.

An invalid value reaches MQTT as `{"value": null}`, which is what the paths publish before
their first successful read. Every controller already ignores a null rather than reading it
as zero, leaving the reading in its never-heard state, so that case needs no second rule.

| Controller | Blind behaviour |
|---|---|
| `thermal-dump-controller.js` (.156) | Suppresses — fan coil and pump off. Recovering waste heat is an optimisation, and burning wood to feed a fan coil is the outcome worth suppressing for |
| `heating-relay-controller.js` (.164) | Sees no ignitions, so the exercise run is not skipped. No other rung reads the Fröling |
| `dhw-controller.js` (.123) | Runs its window **unguarded** |

**DHW degrades towards doing more rather than less.** Losing the reading does not make a cold
buffer any less likely to strip heat out of the cylinders, but it does not make the hot water
less wanted either, and in shortage the buffer is the only route to it. So the window keeps
to its slots and drops the temperature term — the same judgement as letting DHW win on a
marginal buffer. Being wrong costs the heat loop pump and a cool cylinder staying cool.

It does not check that the boiler has been released. .164 releases on the same shortage that
opens the window, so a second copy of that decision here would exclude nothing and cost a
subscription; the heating relay is where that rung lives.

---

## Exercise run

The Fröling needs to move periodically even when it is not needed for heat, to keep augers,
grates and ignition free of tar and moisture. That matters more now the heat pump carries the
bulk of the heating load, because the boiler may sit idle through damp weather.

Every other Sunday at 11:00 the boiler is released for an hour (the minimum on time), unless
it has been seen to light in the previous 14 days. Fixed slots need nothing to survive a
reboot; a reboot only forgets recent ignitions, which costs at most one unneeded exercise.
The Fröling still gates on its own buffer target, so in summer, with the buffer held at 75 °C
by the immersions, a slot may pass without a burn.

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

**No threshold is exposed on any device.** Every relay's numbers live in one table in the
file. They are properties of the system rather than preferences — the immersion stagger
exists so that four 2.7 kW loads come on in turn, and the shortage band is a fact about the
generator and the batteries — so a slider would be a knob for something nobody should turn.
It would also drift: component `202` is shared with the old `smart-load-controller.js` and
stops at 50, so on .209 it can neither express the 30% entry nor be trusted not to carry a
stale value, and on the immersions it put the stagger on the devices in one place and in a
document in another, where the two had already disagreed about .90 and .91.

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

