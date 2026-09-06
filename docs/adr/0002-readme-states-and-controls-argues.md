# README states, CONTROLS argues

The documentation reached 2,100 lines with the same reasoning in two places. `README.md` and
`CONTROLS.md` both argued the VE.Bus-before-lock ordering at similar length, each opened with
its own table of who owns what, and each pointed at the other while restating it. Neither was
wrong; there was simply no test for where a sentence went, so it went in whichever file was
open.

## The rule

**Subject matter is the first cut.** Each document has one subject: the electrical
installation, the heat plant, the coupling between them, the scripts, the vocabulary. The map
of which is which lives in `README.md`, which is where a reader arrives, and this document
does not repeat it.

**Each document may argue within its own subject. README is the single exception.** HEATING
arguing that the certificate skipped an altitude correction is HEATING doing its job. A
script's reasons are never about the script — they are about the system, and the system is
CONTROLS'. So README states: what a script does, what it reads, what it requires, how it is
deployed.

**Where a sentence states rather than argues, count the devices.** One device is README's.
Two or more interacting is CONTROLS'. `text:200 is the status display` against `rung 3 reads
VE.Bus, then .209's lock`.

**Redundancy is allowed at exactly one level of detail.** A table row or a clause may name
another document's material — *Boiler Release: released on sustained shortage, or H1, or DHW
demand, or exercise* — because that is what makes CONTROLS readable as a whole and it is cheap
to keep true. Prose that re-derives it is the expensive kind, and it is what rots.

## The tier

The same test runs inward past the documents:

- A **document** says why the system is the way it is.
- A **commit** says why *this change*. Reasoning that outlives the change moves to a document,
  and the commit points at it.
- **Code** says what it does and points at the document. `dhw-controller.js:1-12` is the
  shape — the ladder in two lines, then `Rules and reasoning in CONTROLS.md#dhw`.

## What was rejected

**Splitting README by audience**, so that README was the portable software project and
everything else was Muttonhall. It cuts the most, and it is a fiction: the scripts key their
behaviour off a device-ID table for this site, so a portable README describes something that
does not exist. What portability is honestly available is one paragraph in README saying so.

**Splitting CONTROLS.** At 644 lines it looked like two documents, but a quarter of it was
material this rule removes rather than relocates. A split adds a boundary, and an unpoliced
boundary is what produced the duplication in the first place.

**Zero redundancy**, each fact exactly once and every other mention a link. It reads worse and
it is a rule nobody keeps.

## Consequences

- README's table is the only map. CONTROLS carries a sentence pointing at it.
- README's per-script sections take the same slots in the same order — device, purpose, what
  it does, what it reads, what it requires, configuration, virtual components. Material that
  fits no slot is in the wrong file, which is the point of having slots.
- A bold heading that is a complete sentence is an argument wearing a heading. Those move to
  CONTROLS.
- CONTROLS loses its status table and its implementation plan. A document is not a record of
  what is deployed — `Script.List` on the device is, and a second copy can be wrong in a way
  the device cannot.
- Reasoning that exists only in a commit message is harvested into a document before the tier
  above stops new commits carrying that weight.
- Cutting is verified rather than assumed: a paragraph is deleted only where the document that
  owns it already says the same thing, and moved first, in its own commit, where it does not.
