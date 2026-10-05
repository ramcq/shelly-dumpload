# README states, CONTROLS argues

The documentation had reached 2,100 lines with the same reasoning in two places: README and
CONTROLS both argued the same design points and each kept its own table of who owns what.
There was no rule for where a sentence belonged.

## The rule

- **Each document has one subject:** the electrical installation (POWER), the heat plant
  (HEATING), how they interact (CONTROLS), the scripts (README), the vocabulary (GLOSSARY). The
  map is in README.
- **README states; every other document may argue within its subject.** README says what a
  script does, reads and requires, and how it is deployed. The reasons behind a script are
  about the system, so they belong in CONTROLS.
- **A fact about one device goes in README; two or more interacting, in CONTROLS.**
- **A table row or a clause may name another document's material.** Prose that re-derives it
  may not.
- **A commit says why this change.** Reasoning that outlives the change goes in a document.
  Code says what it does and points at the document.

## Rejected

- **Splitting README into a portable project and a site guide.** The scripts key off a
  device-ID table for this site, so a portable README would describe something that does not
  exist.
- **Splitting CONTROLS.** Much of it was duplication this rule removes, and a new boundary
  would need policing too.
- **Zero redundancy,** every fact once and every other mention a link. It reads worse and
  nobody keeps it.

## Consequences

- README's per-script sections use the same headings in the same order: device, purpose, what
  it does, what it reads, what it requires, configuration, virtual components.
- CONTROLS keeps no status table or implementation plan. `Script.List` on the device is the
  record of what is deployed.
