# Muttonhall Control Strategy

How the site behaves as a system: when surplus is dumped, when the heat pump may run, when
the biomass is released, and how hot water is made. Which document owns what is in
[README.md](README.md)'s table. What is running on a device is `Script.List` on the device.

---

## Shortage

There is one system state, **shortage**, computed on Heat Pump Enable (.209) from three
readings:

| Term | |
|---|---|
| VE.Bus not Inverting (9), or unknown | Shortage, whatever the latch says |
| SOC at or below **30%** | Latch on |
| SOC at or above **90%** | Latch off |
| Between the two | The latch holds |
| Latch never resolved since boot | Shortage, until generation exceeds **500 W** |
| No reading yet, within five minutes of starting | No action either way |

Neither the Cerbo nor a Shelly script keeps history, so nothing here uses averages or
forecasts. SOC is the integral of generation minus consumption, so it already carries the
energy balance.

**Why a latch.** The loads shortage sheds are the loads that move SOC. Without a latch the
system would shed at 30%, recover to 31% on the load it dropped, un-shed, and be back at 30%
a quarter of an hour later: at 1.5 kW of hydro against a 3 kW heat pump, a 40-minute cycle
all day. Hence the wide band.

**Why 30%.** Ten points above the generator's 20% autostart, about an hour at a realistic
deficit. That is enough time for the heat pump lock (instant) and the biomass (10–15 minutes
to make heat).

**Why 90%.** The generator stops charging at 80%, so above 90% the battery cannot have got
there on diesel.

**Why VE.Bus state rather than the generator service.** State 9 is the only state in which
the system runs normally off-grid. Anything else (a generator on either AC input, a fault,
passthrough, external control) means consumption should come down. It is the gate the dump
loads already used, and it needs no generator condition codes. In the logs, two failed
generator starts held the start relay closed for over an hour with no AC input; VE.Bus stayed
Inverting, correctly. Inverter overload also reaches the heat pump this way: sustained
overload starts the generator, which takes VE.Bus out of Inverting.

VE.Bus sits outside the latch, so a generator run that ends mid-band returns the system to
whatever the latch said, rather than holding the heat pump locked until 90%.

**The latch survives a script restart on the relay contact.** At startup .209 reads its relay
back as the latch, unless the switch's last-command source is `init` (the `initial_state` at
boot, not a decision). On a fresh boot between the thresholds it cannot know which way the
battery was going, so it assumes shortage until it sees more than 500 W of hydro or solar. A
mid-band battery with no renewable generation is what a degraded system looks like between
generator runs, when VE.Bus is back to Inverting and nothing else would catch it.

**There are no dwell timers.** A year of logged SOC replayed against these thresholds gives
under five relay operations a day. VE.Bus does not chatter either: 31 excursions in 184
days, median 12 minutes.

**The startup grace.** A controller polls before MQTT has connected, so a missing VE.Bus
reading is ignored for five minutes after start; otherwise every redeploy would lock the heat
pump for a second or two. Five minutes covers a Cerbo cold boot after a site outage (about
2.5 minutes to MQTT). The grace ends at the first reading and does not return after a broker
drop. Like every interval a script times, it is measured on uptime, not the wall clock:
[ADR 0003](docs/adr/0003-elapsed-time-is-measured-against-uptime.md).

### Shedding is not the same as making heat

| Action | Condition |
|---|---|
| Lock the heat pump, shed the DHW immersions and their time switch | Shortage, immediately |
| Release the biomass | The lock open for **30 minutes** |

Shedding is instant and reversible; lighting a boiler is not. Thirty minutes clears the
fortnightly generator test run (20 minutes minimum, 22.6 in practice) and other transients:
a brief passthrough, a fault that clears, an overload start, or a .209 restart assuming
shortage until it sees generation. A battery shortage waits too; at 30% the generator's 20%
autostart is still about an hour away.

---

## Who decides, and how the decision travels

**.209 decides shortage and acts on it with its own relay,** which is the Grant's heat pump
lock. Everything else follows that relay over MQTT
(`shelly1minig3-d885ac0a3668/status/switch:0`): closed means the heat pump runs, open means
shortage. The 30/90/500 numbers exist only on .209. Why followers read the lock rather than
computing shortage themselves:
[ADR 0001](docs/adr/0001-the-heating-side-follows-the-heat-pump-lock.md).

| Follower | Does while the lock is open |
|---|---|
| DHW immersions (.88 .90 .91 .100) | Shed, time switch included |
| Boiler Release (.164) | Releases the boiler after 30 minutes |
| DHW Enable (.123) | Opens shortage DHW windows |

Manual override: stop .209's script, then set its relay. A running script re-asserts the latch
within one 30-second poll.

**.209 runs the same file as the immersions** (`soc-relay-controller.js`), since they share
the MQTT, keepalive and SOC code. A table row keyed on the device ID gives .209 the shortage
role and drops the dump-load gates. A device not in the table runs nothing, so a misdirected
deploy leaves the relay in its unscripted behaviour.

**Followers ask for the lock at startup** by publishing `status_update` to .209's command
topic, and keep asking until it answers. A lock never heard from sheds nothing: an undeployed
or unreachable .209 costs the immersions their shortage shed and nothing else.

**A broker drop keeps the lock.** Silence is not .209 saying the battery recovered, and
forgetting the lock would shed four immersions on a blip. Readings that may have changed
unseen are cleared instead: a cleared VE.Bus state sheds, a cleared time switch stops asking.

---

## What each actuator does

| Actuator | Rule |
|---|---|
| Heat Pump Enable (.209) | Closed unless in shortage |
| DHW immersions (`soc-relay-controller.js`) | Shed while the lock is open, time switch included; otherwise their SOC bands |
| Buffer immersions (`surplus-dump-controller.js`) | Surplus tracking across three constant stages and the dimmer |
| Boiler Release (.164) | H1, **or** DHW demand, **or** the lock open 30 minutes, **or** the exercise slot |
| DHW Enable (.123) | The time clock, unconditionally; **or** a shortage DHW window |

**H1 stays independent of shortage.** The biomass and the heat pump are inverses only on the
shortage term. H1 is the winter bivalent: at −1 °C the biomass supplements a heat pump that is
still running.

**The boiler needs no burn scheduling.** It has its own 70 °C buffer target, so a release with
nothing to do costs nothing. A burn is roughly an hour: 1500 L from 40 to 70 °C is about
52 kWh of heat, about 16 kWh of electricity at CoP 3.3.

**A release lasts at least an hour.** By then the boiler may have started an ignition cycle,
which is the expensive part. Nothing delays a release, and nothing but time withdraws one.

**The lock sheds the immersions on a generator run too,** even when the time switch is
calling. The cost is up to 2.7 kW less load on a genset that is running anyway.

**The lead relay (.90) briefly fights the shed.** It is `follow`, so the time switch closes it
in hardware and the script turns it off within one poll. A `Switch.Set` overrides `follow`
until the next input edge, so it stays off for the rest of that period: at most 30 seconds of
one immersion, twice a day, in shortage. In return the time switch still makes hot water with
no script running.

---

## Dump loads together

What each script does on its own is in [README.md](README.md).

**Each surplus stage holds its position for ten minutes, either way.** The allocator budgets
a stage at its nominal power, so a stage must stay put long enough to be measured. Below
`minSurplus` (100 W available, with the dumps' own draw added back) every stage goes off
regardless, since that means the battery is carrying the dumps.

**Overload risk, still open.** The surplus controller limits its own loads' inverter
contribution, and each DHW immersion has a generation gate and a headroom check, but nothing
arbitrates between them. If several dump loads are on and generation drops away (a hydro
trip), load can exceed inverter capacity until the loads shed on SOC. The heat pump is not
gated on surplus but is 3–5 kW of the house load the calculation starts from.

**The immersions come back one tank at a time.** SOC crossing four thresholds a point apart
staggers the immersions, but above 96% all four are satisfied at once. The lock closing, or
the time switch turning on, would then switch every immersion on in the same instant, each
headroom check blind to the others: up to 10.8 kW. So on those two edges each relay holds off
enabling for its `pollOffset`, then checks again:

| Tank | Offset |
|---|---|
| Left (.88, .90) | 0 s |
| Right (.91) | 10 s |
| Annex (.100) | 20 s |

The two left elements share an offset because the top one rarely calls, so the pair is one
2.7 kW load in practice. Left at 0 s keeps the click when the time switch closes. Shedding
(the lock opening, the time switch turning off) never waits. Starting several scripts at once
is not staggered, so deploy them one at a time.

---

## DHW

**DHW demand** asks for hot water; **DHW enable** permits heat to move from the buffer into
the cylinders. The three cylinder thermostats decide whether anything moves, so nothing here
senses cylinder temperature.

DHW Enable (.123) closes when **either**:

- **The time clock is on.** Unconditionally, with nothing read over MQTT, so it works with the
  Cerbo down. Normally the clock is off; it exists to be switched to timed or on and make hot
  water with the biomass.
- **A shortage DHW window is open.** In shortage the heat pump is locked and the immersions
  are shed, so the buffer is the only route to hot water.

**Windows are one hour in six:** 05:00, 11:00, 17:00 and 23:00, plus one on entering
shortage so that a shortage starting at 07:30 does not wait until 11:00. Fixed times survive
a reboot with nothing stored. A partial charge resumes six hours later.

**Buffer temperature guards a window.** A window on a cold buffer would strip heat back out
of the cylinders, so it needs **buffer top or boiler flow ≥ 60 °C**. Buffer top measures
stored heat but lags ignition by 10–15 minutes; boiler flow (Fröling register `30001`,
`temperature/103`) rises first but cools when the boiler stops. The guard is checked
throughout the hour and, once passed, holds the enable closed to the end of the window, so a
burn ending mid-window does not cycle the zone valves. A window running into the next one
carries over.

**The time clock wins.** `Switch.Set` overrides `follow` until the next input edge, so the
controller never opens the enable while the clock is calling: a window ending at 06:00 must
not cancel a request made at 05:30.

**DHW demand releases the biomass; a window does not.** A window exists because the heat is
already there.

**No DHW from the buffer outside shortage.** The immersions make the same water from the same
surplus more directly, and running the heat loop pump mixes the buffer, which
`thermal-dump-controller.js` needs stratified.

Nothing arbitrates between DHW and space heating, since the Grant does not know DHW exists.
On a marginal buffer DHW wins.

---

## When the Fröling bridge falls over

When `dbus-froeling` loses its Modbus link it keeps publishing the last value and sets
`/Connected` to 0. Controllers that rely on a Fröling reading also read `/Connected`, and
keep asking for it with the keepalive, since it changes rarely. One path covers all four
services, which share a Modbus client. A value that was never read arrives as
`{"value": null}`, which every controller already ignores.

| Controller | With the bridge down |
|---|---|
| `thermal-dump-controller.js` (.156) | Suppresses the fan coil and pump, since a stale "boiler stopped" could run them during a burn |
| `heating-relay-controller.js` (.164) | Sees no ignitions, so the exercise slot is not skipped. No other rung reads the Fröling |
| `dhw-controller.js` (.123) | Runs its windows without the temperature guard |

**DHW assumes the boiler works.** In shortage .164 has released the boiler, and the buffer is
the only route to hot water, so a stale reading must not block it. Being wrong costs the heat
loop pump and a cool cylinder staying cool.

---

## Exercise run

The Fröling needs to move periodically even when no heat is needed, to keep augers, grates
and ignition free of tar and moisture, and it may sit idle through damp weather now the heat
pump carries the heating.

Every other Sunday at 11:00 the boiler is released for an hour (the minimum on time), unless
it has been seen to light in the previous 14 days. Ignitions are remembered in RAM, so a
reboot costs at most one unneeded exercise. In summer, with the buffer held at 75 °C by the
immersions, a slot may pass without a burn.

---

## Deliberately absent

**No alerting.** The Fröling has its own remote monitoring.

**DHW Enable cannot tell whether a charge happened.** .123 has no metering. A 1PM in its place
would see the stat, valve and pump load: useful for diagnostics, not needed for control.

**The immersions do not watch the boiler.** In shortage the heat pump and immersions are both
off, so SOC climbs on hydro whether or not the boiler lit, and the immersions return at 90%.
A jammed hopper becomes a slow return to electric heating over about a day.

**The EVSE is not shed on shortage.** Manual mode means charge regardless. Auto mode stops on
its own surplus criteria.

**No threshold is exposed on any device.** Every relay's numbers live in one table in the
file. A slider drifts: component `202` is shared with the old `smart-load-controller.js`,
stops at 50, and had already disagreed with the documents about .90 and .91.

**No heat pump headroom check.** Its draw modulates between about 0.5 and 5 kW and its meter
is not on the Cerbo, so any reserved constant would be wrong. Overload reaches it through
VE.Bus.

---

## Relay configuration

Each relay's behaviour with no script running should be sensible: for a relay inserted into
existing controls, what the system did before the Shelly; for a dump load, off.

| Relay | Configuration | Unscripted behaviour |
|---|---|---|
| Heat Pump Enable (.209) | `detached`, `initial_state: "on"`, no `auto_on`/`auto_off` | Heat pump runs. Nothing is wired to its input, so `match_input` would lock it out on every power cycle. A device timer would look like a decision to the latch read-back |
| Boiler Release (.164) | `follow`, `match_input` | H1 releases the boiler in hardware. The relay is normally-open and cannot be a changeover |
| DHW Enable (.123) | `follow`, `match_input` | The time clock passes straight through |
| Buffer immersions (.65, .161) | `detached`, `initial_state: "off"` | Nothing dumps; an input edge cannot override the controller |
| DHW immersions (.88 .91 .100) | `detached`, `initial_state: "off"` | Nothing heats until a controller says so |
| DHW immersion lead relay (.90) | `follow`, `match_input` | The manual time switch still makes hot water |

A `Switch.Set` overrides `follow` until the next input edge, so a script can hold .164, .123
or the lead relay closed for its own reasons without giving up the hardware path.
