'use strict';

const { parseCsv } = require('../index');

/**
 * Count records per value of `column`, as `name=count` lines, sorted by name.
 *
 * An absent or empty value is counted under `(none)`.
 */
function tally(text, column) {
  const { rows } = parseCsv(text);
  const counts = {};
  for (const row of rows) {
    const key = row[column] === '' || row[column] == null ? '(none)' : row[column];
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}=${counts[k]}`)
    .join('\n');
}

module.exports = { tally };
