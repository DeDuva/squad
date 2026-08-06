'use strict';

const { parseCsv } = require('../index');

const ROWS = Number(process.env.BENCH_ROWS || 20000);

let text = 'id,name,city\n';
for (let i = 0; i < ROWS; i += 1) text += `${i},name${i},city${i % 50}\n`;

const started = Date.now();
const { rows } = parseCsv(text);
const elapsed = Date.now() - started;

if (rows.length !== ROWS) {
  console.error(`expected ${ROWS} rows, parsed ${rows.length}`);
  process.exit(1);
}
console.log(JSON.stringify({ rows: rows.length, elapsedMs: elapsed }));
