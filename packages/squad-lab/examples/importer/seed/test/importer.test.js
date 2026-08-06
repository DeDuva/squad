'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv } = require('../index');
const { tally } = require('../consumers/tally');

test('parses a header and records', () => {
  const { header, rows } = parseCsv('name,city\nada,london\ngrace,newport\n');
  assert.deepStrictEqual(header, ['name', 'city']);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, 'ada');
  assert.strictEqual(rows[1].city, 'newport');
});

test('keeps commas inside quoted fields', () => {
  const { rows } = parseCsv('name,note\nada,"one, two"\n');
  assert.strictEqual(rows[0].note, 'one, two');
});

test('accepts CRLF line endings', () => {
  const { rows } = parseCsv('name,city\r\nada,london\r\n');
  assert.strictEqual(rows[0].city, 'london');
});

test('tally counts by column', () => {
  assert.strictEqual(tally('name,city\nada,london\ngrace,london\n', 'city'), 'london=2');
});
