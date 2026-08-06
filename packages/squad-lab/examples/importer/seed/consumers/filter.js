'use strict';

const { parseCsv } = require('../index');

/** Records whose `column` equals `value`, re-emitted as CSV with the header. */
function filter(text, column, value) {
  const { header, rows } = parseCsv(text);
  const kept = rows.filter((row) => row[column] === value);
  const lines = [header.join(',')];
  for (const row of kept) lines.push(header.map((name) => row[name]).join(','));
  return lines.join('\n');
}

module.exports = { filter };
