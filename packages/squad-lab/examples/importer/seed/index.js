'use strict';

const { tokenize } = require('./lib/tokenizer');

/**
 * Parse a CSV document.
 *
 * The first row is the header. Every following row becomes an object keyed by
 * the header names.
 *
 * @param {string} text
 * @returns {{ header: string[], rows: Record<string, string>[] }}
 */
function parseCsv(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { header: [], rows: [] };

  const header = tokens[0];
  const rows = tokens.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, i) => {
      record[name] = cells[i] === undefined ? '' : cells[i];
    });
    return record;
  });

  return { header, rows };
}

module.exports = { parseCsv };
