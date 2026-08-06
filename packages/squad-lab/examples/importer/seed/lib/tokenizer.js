'use strict';

/**
 * CSV tokenizer.
 *
 * Splits a document into rows of fields, handling quoted fields that may
 * contain commas and newlines. See README.md for the format this is meant to
 * accept.
 */

/**
 * Tokenize a CSV document into an array of arrays of strings.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function tokenize(text) {
  let rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row = row.concat([field]);
      field = '';
    } else if (ch === '\n') {
      row = row.concat([field]);
      rows = rows.concat([row]);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  return rows;
}

module.exports = { tokenize };
