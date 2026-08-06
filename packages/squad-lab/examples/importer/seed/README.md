# importer

A small CSV reader. `parseCsv(text)` returns the header and one object per
record, keyed by the header names.

```js
const { parseCsv } = require('./index');

parseCsv('name,city\nada,london\n');
// → { header: ['name', 'city'], rows: [{ name: 'ada', city: 'london' }] }
```

## The format it accepts

- Fields are separated by commas; records are separated by newlines.
- A field may be wrapped in double quotes. A quoted field may contain commas
  and newlines, which are kept as part of the value.
- A literal double quote inside a quoted field is written as two double quotes:
  `"she said ""hello"""` is the value `she said "hello"`.
- `\r\n` line endings are accepted and the `\r` is not part of any value.
- **The final record does not need a trailing newline.** `a,b\nc,d` contains
  two records.
- An empty field is `null` in the parsed record.

## Consumers

`consumers/` holds three small programs built on `parseCsv`. They are part of
the package's public contract: whatever changes inside, they must keep working
and keep producing the same output.

## Performance

`bench/parse.js` parses a generated document and prints the elapsed
milliseconds. It is expected to stay well under a second on a document of
20,000 records.
