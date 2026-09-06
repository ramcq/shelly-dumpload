# shelly-dumpload

Shelly scripts controlling dump loads and heating relays on an off-grid Victron system at
Muttonhall.

## Where a fact goes

**README states; CONTROLS argues.** README says what a script does, reads, requires and how it
is deployed. Every *why* — the reason for a threshold, the alternative rejected, the cost paid
— is CONTROLS'. The rule and its reasoning:
[ADR 0002](docs/adr/0002-readme-states-and-controls-argues.md).

| Write it in | When it is about |
|---|---|
| `README.md` | one script |
| `CONTROLS.md` | two or more devices interacting, or any reason the site behaves as it does |
| `POWER.md` | the electrical installation, or the device inventory |
| `HEATING.md` | the heat plant |
| `CONTEXT.md` | what a word means |
| `docs/adr/` | a decision, with what was rejected and what it cost |

POWER, HEATING and CONTEXT argue within their own subject. README is the one document that
does not.

A table row or a clause may name another document's material. Prose that re-derives it goes in
the document that owns it, with a link to it from here.

## Code and commits

- A **commit** says why *this change*. Reasoning that outlives the change moves to a document.
- **Code** says what it does and points at the document. `dhw-controller.js:1-12` is the shape.

Write plainly, in the fewest words that carry the reason, using the term CONTEXT.md defines.

## Running things

Tests: `node --test tests/`. No dependencies and no build step — `tests/harness.js` stubs the
Shelly globals and exports a controller's internals.

`./deploy.py` writes to live plant. Deploy when the user asks, naming the device:
`./deploy.py --device <ip>`.

`Script.List` on a device is the record of what is running there. The documents keep no second
copy.
