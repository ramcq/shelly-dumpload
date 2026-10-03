# Elapsed time is measured against uptime

Every interval a controller measures within one run of its script — a startup grace, a
minimum on time, a sustained-shortage wait, a stall grace, a relay change lock — is measured
against the device's uptime, read from `sys.uptime`. The wall clock is used for one thing
only: the exercise run, which spans a reboot and reads `syncedNow()`.

A Shelly's `Date.now()` returns a restored RTC value until NTP lands, and the sync then jumps
the clock forward by however long the device was off. Measured on .164 and .209 eighty-three
minutes after a reboot, `Date.now() - state.startedAt` read **11.96 days** against a real
uptime of 5016 seconds. Any interval stamped before the sync and compared after it is
therefore enormous, and every threshold it is tested against has already been passed.

That is not a theoretical failure. On 2026-09-14 it burned roughly 52 kWh of wood into an
already-warm buffer. .209's three-minute startup grace evaporated the instant NTP landed, so
`inShortage()` returned `true` — "I have had no VE.Bus reading and my grace has expired" —
rather than `null`, and .209 commanded the heat pump lock open 34 seconds after boot. .164
read a *commanded* open lock with VE.Bus inverting, which by design means one thing only, and
released the boiler for the full hour of `release.minimumOnTime`. .123 armed a shortage DHW
window on the same edge. Every controller behaved exactly as written; the clock lied to all
three.

## What was rejected

**Detecting the jump and restamping.** Keep `Date.now()`, and when it moves by more than a
poll interval, treat the difference as a sync and move every stamp with it. This preserves
wall-clock semantics and needs no new reading. It was rejected because it is a correction
applied after the fact to a value that was never right, and it has to be got right in every
file that holds a stamp — the same surface area as the change we made, with a moving part
added rather than removed.

**Raw device uptime, with no per-run stamp.** `sys.uptime` alone is monotonic, which is the
whole property we want. It was rejected because it does not reset when a script restarts: a
redeploy onto a device that has been up five days reads five days, the startup grace is over
before the script has subscribed to anything, and the redeploy locks the heat pump and sheds
four immersions — which is the exact failure the grace was written to prevent. So the stamp
is taken once at script start and intervals are measured from it.

**Giving the lock a third value.** .209 could publish its confidence — "short", "not short",
"I do not know yet" — so that a follower could tell a measured shortage from an unresolved
one. This was the fix aimed at the symptom rather than the cause, and it was rejected: it
adds an interface between devices, and three followers that must learn to read it, to work
around a clock that can simply be made not to lie. The lock stays one boolean, as
[ADR 0001](0001-the-heating-side-follows-the-heat-pump-lock.md) has it.

**Letting a release be withdrawn.** `release.minimumOnTime` could be made conditional, so
that a release whose reason vanishes before the boiler has lit could be taken back. Rejected
for the same reason: the asymmetry between shedding load and lighting a fire is deliberate,
and weakening it to cover a clock bug would cost the property it exists for.

## What it costs

`sys.uptime` is integer seconds, so every interval is quantised to a second. At the scales
these intervals run to — minutes and hours — that is nothing.

The reading is taken once per pass. A pass is the control evaluation, `checkSystemState()`,
and additionally any handler that *stamps* an interval of its own before triggering one —
`.164` and `.123` on a message, `.156` on an output event. A handler that only records a
reading takes none, and a reporter such as `updateStatus()` never takes its own: it uses the
instant the pass established, so the intervals one evaluation compares cannot drift against
each other.

Until the first reading succeeds there is no instant to measure from, and `state.nowUptime`
is `null` rather than zero. Zero would be a lie of exactly the shape this ADR exists to
remove: a script whose opening read failed would date itself to the epoch and find, on its
next reading, that a device up five days had run out its grace before it had subscribed to
anything. Null propagates instead — a stamp taken from it is null, which every call site
already reads as "never happened" — and an interval that cannot be measured has not
elapsed.

"Never happened" is `null`, not `0`, and every site tests for it explicitly. Under the wall
clock a `0` sentinel was safe by accident — `Date.now() - 0` is enormous, so an interval
never stamped read as long elapsed, which is what the call sites wanted. Uptime inverts that:
`state.nowUptime - 0` is small, so a truthiness guard that happened to be absent turns
"never" into "just now". `surplus-dump-controller.js`'s stall grace was exactly such a site.

Each controller carries its own copy of `refreshUptime()`. There is no module system and no
build step — `deploy.py` uploads a file unaltered — so a helper shared by five scripts is
five copies of it, and a change to the rule is five edits.
