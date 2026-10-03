# Elapsed time is measured against uptime

Every interval a controller measures within one run of its script (startup grace, minimum on
time, the 30-minute lock wait, stall grace, change lock) uses `sys.uptime`, measured from a
stamp taken at script start. The wall clock is used only where a schedule needs the time of
day: the DHW windows and the exercise slot, both only once NTP has synced.

## Why

Until NTP lands, a Shelly's `Date.now()` returns its restored RTC value; the sync then jumps
the clock forward by however long the device was off. On .164 and .209, 83 minutes after a
reboot, `Date.now() - state.startedAt` read 11.96 days against an uptime of 5016 seconds.
Any interval stamped before the sync is over the moment it lands.

On 2026-09-14 this burned about 52 kWh of wood into a warm buffer. .209's startup grace
expired when NTP landed, so with no VE.Bus reading yet it reported shortage and opened the
lock 34 seconds after boot. .164 released the boiler for its full minimum on time, and .123
opened a DHW window.

## Rejected

- **Detecting the jump and moving every stamp with it.** Each file would still have to get
  every stamp right, with an extra correction step.
- **Raw `sys.uptime` with no per-run stamp.** Uptime does not reset when a script restarts,
  so a redeploy onto a device up five days would start with its grace already over.
- **A third lock value meaning "not sure yet".** It would add an interface between devices
  to work around a clock that can simply be read correctly. The lock stays a boolean
  ([ADR 0001](0001-the-heating-side-follows-the-heat-pump-lock.md)).

## Consequences

- `sys.uptime` is whole seconds; at these intervals that does not matter.
- Uptime is read once per pass into `state.nowUptime`, and is `null` until the first
  successful read. "Never happened" is `null`, never `0`: under uptime, `now - 0` is small,
  so a `0` sentinel would read as "just now".
- There is no module system, so each controller carries its own `refreshUptime()`.
