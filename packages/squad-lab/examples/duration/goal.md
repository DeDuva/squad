Add a duration parser module

Create `duration.js` in the repository root exporting a function
`parseDuration(input)`.

It takes a duration string and returns the total number of **seconds** as a
number, or `null` when the input is not a valid duration.

Valid forms:
- combined units, largest first: `1h30m`, `1h30m15s`, `2h15s`
- a single unit: `2h`, `5m`, `90s`
- a bare integer, which means seconds: `45`, `0`
- surrounding whitespace is ignored: `  1h30m  `

Everything else returns `null` — never throw. That includes an empty or
whitespace-only string, an unknown unit (`1x`), a unit with no value (`h`), a
trailing bare number after a unit (`1h30`), a negative value (`-5m`), and any
non-string input including `null` and `undefined`.

Also add tests for the module in the repository, and make sure they pass.
