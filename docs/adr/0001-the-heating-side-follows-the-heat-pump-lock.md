# The heating side follows the heat pump lock

Heat Pump Enable (.209) computes shortage and shows the answer on its relay: closed means the
heat pump runs, open means shortage. The DHW immersions, Boiler Release (.164) and DHW
Enable (.123) read that relay over MQTT. None of them holds the thresholds or subscribes to
the power system to decide shortage.

## Rejected: every controller computes shortage itself

Each controller would read VE.Bus state, SOC and generation and apply the rule itself. That
removes the dependency on .209, and it looked cheap while picking up another Shelly's current
state meant an HTTP request per follower with retries. Two things decided against it:

- **Asking for a Shelly's state became cheap.** Publishing `status_update` to its
  `<prefix>/command` topic makes it republish every component on `<prefix>/status/…`, which a
  follower already subscribes to. One message, no HTTP, no retries.
- **It would put the power system in the heating scripts.** The rule needs four Victron
  subscriptions plus a copy of 30/90/500. On .123, whose job is moving heat from the buffer
  into the cylinders, that would mean seven of Shelly's ten subscriptions. Following the lock
  costs one.

Following a relay also makes manual control simple: stop .209's script, set its relay, and
the heating side follows. With every controller computing shortage, there is nothing to
override.

## Consequences

- The latch and its terms live on .209 only, in RAM. A restart starts it unresolved (see
  [CONTROLS.md](../../CONTROLS.md#shortage)).
- Followers depend on .209. Without it each keeps its own behaviour: the immersions keep their
  SOC band, generation gate and VE.Bus gate; .164 still gets H1 in hardware; .123 still
  passes the time clock through in hardware.
- A lock never heard from sheds nothing.
- .164 releases the boiler once the lock has been open 30 minutes, whatever opened it.
