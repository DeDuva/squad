Add a ledger summariser

Create `ledger.js` in the repository root exporting a function
`summarise(text)`.

It takes the text of a ledger file and returns a summary object. It must never
throw.

Each non-empty line of the ledger is a record with four whitespace-separated
fields:

```
2026-01-05 groceries -12.34 USD
```

date, category, amount, currency. Amounts may be negative, may have zero, one
or two decimal places, and may carry a leading `+`. Runs of spaces or tabs
between fields count as one separator. Lines that are empty or contain only
whitespace are skipped entirely. A line whose first non-whitespace character is
`#` is a comment and is skipped.

Return an object with exactly these keys:

- `count` — how many records parsed successfully.
- `totalCents` — the sum of every parsed amount, **in whole cents**, as a
  number. `-12.34` contributes `-1234`. Work in cents rather than floats:
  `0.1 + 0.2` must come out as `30`, not `30.000000000000004`.
- `byCategory` — an object mapping each category to its total in cents.
- `currencies` — the distinct currencies seen, as an array sorted
  alphabetically.
- `errors` — an array of `{ line, reason }` for every rejected line, where
  `line` is the 1-based line number in the original text.

A line is rejected, and contributes to nothing else, when it has fewer or more
than four fields, when the date is not `YYYY-MM-DD`, when the amount is not a
valid number in the form described above (more than two decimal places is
invalid), or when the currency is not exactly three uppercase letters.

The `reason` strings are yours to choose; only their presence is checked.

`summarise('')` returns a summary with `count: 0`, `totalCents: 0`, an empty
`byCategory`, an empty `currencies` and an empty `errors`. Any non-string input
returns that same empty summary rather than throwing.

Also add tests for the module in the repository, and make sure they pass.
