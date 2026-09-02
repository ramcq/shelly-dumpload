# The heating side follows the heat pump lock

Heat Pump Enable (.209) works out whether the system is short of energy and expresses the
answer on its relay: closed means the heat pump is running, open means shortage. The DHW
immersions read that relay over MQTT, and Boiler Release (.164) and DHW Enable (.123) will
do the same. None of them holds the thresholds, and none of them subscribes to the power
system to answer "am I allowed".

The alternative, built and then withdrawn before deployment, was for every controller to
derive shortage itself from the three readings it rests on — VE.Bus state, battery SOC and
total generation. That removes the dependency on .209 being alive, and it looked cheap while
seeding a followed value meant an HTTP request per follower with a retry chain behind it.

Two things decided against it.

**The seed stopped costing anything.** Publishing `status_update` to a device's
`<prefix>/command` topic makes it republish every component on `<prefix>/status/…` — the
topics a follower already subscribes to. So picking up the current value of a remote switch
costs one subscription the follower wanted anyway and one published message, with no reply
topic, no HTTP and no retry machinery. That is the same trick the Victron keepalive uses, and
it needs only `enable_control`, which is on by default.

**Deriving it would have put the power system inside the heating scripts.** The shortage
rule needs four Victron subscriptions. `.123` — whose entire job is letting heat move from
the buffer into three cylinders — would have carried battery state of charge, inverter state
and two generation meters, reaching eight of Shelly's ten subscriptions, plus its own copy
of 30/90/500. Following the lock costs it one subscription and no knowledge of the battery
at all.

Expressing it on a relay also makes manual control a first-class operation: stop .209's
script, put the relay where you want it, and the whole heating side follows. Stopping it
first is part of the operation — a running script re-asserts the latch on its next poll. A
derived design has nothing to override at all, because every device would recompute around
you.

## What survives from the derived design

The **latch** and its terms, which now live on .209 alone. Shortage is latched between 30%
and 90% because the loads it sheds are the same loads that move SOC: a rule reading only the
present sheds at 30%, sees the battery recover to 31% on the load it just dropped, un-sheds,
and is back at 30% a quarter of an hour later — a 40-minute cycle on the heat pump for as
long as generation is present but short of what the heat pump draws.

**Generation settles a latch that has never been resolved.** A controller starting between
the thresholds cannot know which way the battery was going, so it assumes shortage and
clears once it sees more than 500 W of hydro or solar. That assumption is the safe end
because a mid-band battery with no renewable generation is what a significantly degraded
system looks like — the generator starting periodically to top the battery up for the house
— and between those runs VE.Bus is back to Inverting, so nothing instantaneous catches it.

**.209's relay contact is the latch's durable home.** It survives a script restart, and the
switch's last-command source distinguishes that from a contact nothing has touched, where the
relay is only `initial_state: "on"` — a source of `init` is a configuration default, not a
decision. So a redeploy does not discard what the relay already knew, while the assumption
above covers both a fresh boot and a script deployed hours into one: the source says which,
where an uptime reading would have read the default as a released heat pump.

## Consequences

- Followers depend on .209. Each degrades to the behaviour it ships with today: the
  immersions keep their own SOC band, generation gate and VE.Bus gate, `.164` still gets H1
  in hardware, `.123` still passes the time clock through in hardware.
- A lock never heard from sheds nothing, so an undeployed or unreachable .209 costs the
  immersion floor and nothing else.
- `.164` reads VE.Bus itself and the lock second, in that order. Not an inference: .209 opens
  the lock *because* VE.Bus left Inverting, so answering VE.Bus first leaves the lock exactly
  one thing left to mean — the battery — and the 30-minute wait for everything else is timed
  against a reading `.164` watches itself rather than against when `.209` changed its mind.
- The 30, 90 and 500 W numbers exist in exactly one deployment, on one device.
