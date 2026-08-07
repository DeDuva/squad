Add a CSV parser module

Create `csvparse.js` in the repository root exporting a function
`parseCsv(text)`.

It takes the full text of a CSV document and returns an **array of rows**, each
row an array of string fields. It must never throw.

Field and record rules:

- Fields are separated by commas, records by newlines. Both `\n` and `\r\n`
  end a record, and the two may be mixed in one document.
- A field may be wrapped in double quotes. Inside a quoted field, a comma, a
  `\n` and a `\r\n` are ordinary characters and do **not** end the field or the
  record.
- Inside a quoted field, two consecutive double quotes mean one literal double
  quote. `"a""b"` is the field `a"b`.
- A quoted field's surrounding quotes are not part of the value. An unquoted
  field's value is exactly its characters, including any spaces —
  ` a , b ` is three-character fields `" a "` and `" b "`, not `a` and `b`.
- A quote that appears in the middle of an unquoted field is a literal
  character: `a"b` is the field `a"b`.
- Empty fields are empty strings. `a,,b` is three fields. A line that is just
  `,` is two empty fields.
- A trailing newline at the end of the document does not create a final empty
  record. `"a\nb\n"` is two records, not three.
- A completely empty document (`""`) returns an empty array.
- A record that consists of a single empty unquoted field — a blank line in the
  middle of the document — is preserved as a row containing one empty string.
- If the document ends inside an unterminated quoted field, return everything
  parsed so far including that field, with the text collected up to the end.
- A leading UTF-8 byte-order mark (`﻿`) is stripped from the first field
  of the first record and from nowhere else.

Any non-string input — `null`, `undefined`, a number, an object — returns an
empty array rather than throwing.

Also add tests for the module in the repository, and make sure they pass.
