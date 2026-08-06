/**
 * The importer task, checked as an *instrument* rather than as code.
 *
 * A grading rubric can be perfectly correct and still useless: the duration
 * example was, because every model scored 1.00 on it and a measurement whose
 * instrument tops out below the range of its subjects reports the instrument.
 * So what is asserted here is not "the grader works" but three properties that
 * decide whether an experiment using it can resolve anything at all.
 *
 *   1. the untouched seed scores well below ceiling — there is room to improve
 *   2. a correct fix reaches ceiling — the task is actually achievable
 *   3. the axes disagree for a defensible solution — no single number would do
 *
 * If a future edit breaks any of these, the task has quietly stopped being able
 * to tell two models apart, and no failure anywhere else would say so.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'squad-lab',
  'examples',
  'importer',
);

interface Axis {
  score: number | null;
  passed: boolean;
  summary: string;
  metrics?: Record<string, unknown>;
}

function grade(repo: string): Record<string, Axis> {
  const out = execFileSync('node', [join(EXAMPLE, 'grader.mjs'), repo], {
    encoding: 'utf8',
    timeout: 240_000,
  });
  return (JSON.parse(out) as { axes: Record<string, Axis> }).axes;
}

/** The linear, fully-correct tokenizer a good run is expected to arrive at. */
const FIXED_TOKENIZER = `'use strict';
function tokenize(text) {
  const rows = [];
  let row = [], field = '', quoted = false, seenAny = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    seenAny = true;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\\r') field += ch;
  }
  if (seenAny && (field !== '' || row.length > 0)) { row.push(field); rows.push(row); }
  return rows;
}
module.exports = { tokenize };
`;

const NOTES = `# Notes

The README says an empty field is \`null\`; the code returns an empty string and
\`consumers/report.js\` interpolates it directly. **Decision: kept the empty
string**, because changing it is a breaking change to the public contract for
the sake of one line of documentation.
`;

let root: string;
let seed: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'importer-task-'));
  seed = join(root, 'seed');
  cpSync(join(EXAMPLE, 'seed'), seed, { recursive: true });
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const copyOf = (name: string): string => {
  const dir = join(root, name);
  cpSync(seed, dir, { recursive: true });
  return dir;
};

describe('the untouched seed leaves room to improve', () => {
  let axes: Record<string, Axis>;
  beforeAll(() => {
    axes = grade(seed);
  }, 240_000);

  it('fails roughly half the hidden suite, on the two defects nothing states', () => {
    expect(axes['correctness']!.score).toBeGreaterThan(0.3);
    expect(axes['correctness']!.score).toBeLessThan(0.8);
    const failures = (axes['correctness']!.metrics!['failures'] as { case: string }[]).map((f) => f.case);
    expect(failures).toEqual(expect.arrayContaining(['no trailing newline', 'escaped quote']));
  });

  it('scores zero on performance, because quadratic is not slow — it is wrong', () => {
    // Asserted as "near zero" rather than exactly zero: the score is derived
    // from wall-clock, and a test that pins a timing-derived value to the
    // digit fails on somebody else's machine for no useful reason.
    expect(axes['performance']!.score).toBeLessThan(0.1);
  });

  it('scores zero on ambiguity, having said nothing about the conflict', () => {
    expect(axes['ambiguity']!.score).toBe(0);
  });

  it('still passes its own suite and its consumers, which is why the defects survive', () => {
    // The green suite is the point: a run that trusts it learns nothing.
    expect(axes['self-tests']!.score).toBe(1);
    expect(axes['regression']!.score).toBe(1);
  });
});

describe('a correct fix reaches the ceiling', () => {
  it('scores 1.00 on every axis', () => {
    const repo = copyOf('fixed');
    writeFileSync(join(repo, 'lib', 'tokenizer.js'), FIXED_TOKENIZER);
    writeFileSync(join(repo, 'NOTES.md'), NOTES);

    const axes = grade(repo);
    for (const [name, axis] of Object.entries(axes)) {
      expect(axis.score, `${name}: ${axis.summary}`).toBe(1);
    }
  }, 240_000);
});

describe('the axes disagree for a defensible solution', () => {
  it('costs a regression point to follow the README to the letter', () => {
    // Correct by the documentation, and it changes what a consumer prints.
    // There is no reading of this task on which one number is the answer —
    // which is exactly what the duration example lacked.
    const repo = copyOf('readme-literal');
    writeFileSync(join(repo, 'lib', 'tokenizer.js'), FIXED_TOKENIZER);
    writeFileSync(join(repo, 'NOTES.md'), NOTES);
    const index = readFileSync(join(repo, 'index.js'), 'utf8').replace(
      "record[name] = cells[i] === undefined ? '' : cells[i];",
      "record[name] = cells[i] === undefined || cells[i] === '' ? null : cells[i];",
    );
    writeFileSync(join(repo, 'index.js'), index);

    const axes = grade(repo);
    expect(axes['correctness']!.score).toBe(1);
    expect(axes['regression']!.score).toBeLessThan(1);
  }, 240_000);
});

describe('the grader survives what a bad run delivers', () => {
  it('reports an unscored performance axis rather than crashing when the bench is gone', () => {
    const repo = copyOf('no-bench');
    rmSync(join(repo, 'bench'), { recursive: true, force: true });
    const axes = grade(repo);
    // Unscored, not zero: the measurement did not happen, which is not the
    // same as a run that was slow.
    expect(axes['performance']!.score).toBeNull();
  }, 240_000);

  it('scores zero correctness, not an exception, when the entry point is gone', () => {
    const repo = copyOf('no-index');
    rmSync(join(repo, 'index.js'), { force: true });
    const axes = grade(repo);
    expect(axes['correctness']!.score).toBe(0);
    expect(axes['correctness']!.summary).toMatch(/index\.js/);
  }, 240_000);
});
