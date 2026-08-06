'use strict';

const { parseCsv } = require('../index');

/** One line per record: the header names and values joined with `: ` and `; `. */
function report(text) {
  const { header, rows } = parseCsv(text);
  return rows
    .map((row) => header.map((name) => `${name}: ${row[name]}`).join('; '))
    .join('\n');
}

module.exports = { report };
