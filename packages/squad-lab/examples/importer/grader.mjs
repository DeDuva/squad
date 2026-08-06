/**
 * The hidden suite for the importer assignment: five axes, none of them
 * blended, and two of them designed to pull against each other.
 *
 * The M7 slice returned a three-way tie because its task had a ceiling — the
 * brief enumerated its own acceptance criteria, so a competent implementation
 * was a transcription and every model scored 1.00. This task has no such
 * ceiling: the defects are unstated, the performance axis is continuous, and
 * one of the two documented behaviours cannot be satisfied without breaking a
 * consumer.
 *
 *   correctness  the delivered parser against ~20 cases the agents never saw,
 *                weighted so the two unstated defects carry most of the score
 *   regression   the three consumer programs, which are the package's public
 *                contract, still producing what they produced before
 *   performance  the benchmark, scored continuously — this is the axis that
 *                almost never ties
 *   ambiguity    the README and the code disagree about empty fields, and the
 *                consumers depend on the code. There is no right answer, only
 *                the right behaviour: decide, and say so in NOTES.md
 *   self-tests   the repository's own suite, as in the duration example
 *
 * **`regression` and `ambiguity` are in genuine tension.** Following the README
 * to the letter changes what the consumers print, which costs regression
 * points; leaving the code alone contradicts the documentation. A run that
 * notices and records the trade-off scores well on `ambiguity` whichever side
 * it picks — which is the point. A blended score would hide all of this.
 *
 * Determinism: every axis but `performance` is a pure function of the delivered
 * tree. `performance` is a wall-clock measurement and therefore noisy, which is
 * why it is scored against thresholds an order of magnitude apart rather than
 * against a precise target.
 *
 * Usage: node grader.mjs <path-to-work-repo>  → JSON on stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Scored 1.0 at or under the target, 0.0 at or over the ceiling, log-linear
 * between.
 *
 * The seed parses in ~300ms and a linear implementation in ~12ms, so the
 * ceiling sits below the seed rather than at it: a defect this large should
 * score zero on any machine, not a small number on a slow one.
 */
const PERF_TARGET_MS = 60;
const PERF_CEILING_MS = 200;
const BENCH_ROWS = 20000;

/**
 * `[label, input, expected, weight]`. `expected` is a function so a case can
 * accept either side of the documented ambiguity.
 *
 * The two unstated defects carry weight 3 each: they are what separates a run
 * that read the format description from one that ran the shipped tests and
 * stopped.
 */
const CASES = [
  ['header and records', 'name,city\nada,london\n', (r) => r.length === 1 && r[0].name === 'ada' && r[0].city === 'london', 1],
  ['two records', 'a,b\n1,2\n3,4\n', (r) => r.length === 2 && r[1].a === '3', 1],
  ['comma inside quotes', 'a,b\n"one, two",x\n', (r) => r[0].a === 'one, two', 2],
  ['newline inside quotes', 'a\n"one\ntwo"\n', (r) => r.length === 1 && r[0].a === 'one\ntwo', 2],
  ['CRLF endings', 'a,b\r\n1,2\r\n', (r) => r[0].b === '2', 1],
  // Defect one: the README says the final record needs no trailing newline.
  ['no trailing newline', 'a,b\nc,d', (r) => r.length === 1 && r[0].a === 'c' && r[0].b === 'd', 3],
  ['no trailing newline, two records', 'a\n1\n2', (r) => r.length === 2 && r[1].a === '2', 3],
  // Defect two: `""` is a literal quote.
  ['escaped quote', 't\n"she said ""hi"""\n', (r) => r[0].t === 'she said "hi"', 3],
  ['escaped quote alone', 't\n""""\n', (r) => r[0].t === '"', 3],
  ['two escaped quotes', 't\n"a""b""c"\n', (r) => r[0].t === 'a"b"c', 2],
  ['quoted empty field', 'a,b\n"",x\n', (r) => r[0].a === '' || r[0].a === null, 1],
  ['spaces are preserved', 'a\n  x  \n', (r) => r[0].a === '  x  ', 1],
  ['quoted field with comma and quote', 'a\n"x, ""y"""\n', (r) => r[0].a === 'x, "y"', 2],
  ['short row leaves missing fields empty', 'a,b,c\n1,2\n', (r) => r[0].c === '' || r[0].c === null, 1],
  ['empty input', '', (r) => r.length === 0, 1],
  ['header only', 'a,b\n', (r) => r.length === 0, 1],
  ['header only, no newline', 'a,b', (r) => r.length === 0, 1],
  ['value containing only a comma', 'a\n","\n', (r) => r[0].a === ',', 2],
  ['unicode is preserved', 'a\nnaïve\n', (r) => r[0].a === 'naïve', 1],
  // Deliberately accepts both: this is the ambiguity, scored on its own axis.
  ['empty unquoted field (either reading)', 'a,b\nx,\n', (r) => r[0].b === '' || r[0].b === null, 1],
];

function loadParser(repo) {
  const entry = join(repo, 'index.js');
  if (!existsSync(entry)) return { error: 'index.js is missing' };
  try {
    const require = createRequire(import.meta.url);
    // The run may legitimately have rewritten internals; only the entry point
    // and its export are contract.
    for (const key of Object.keys(require.cache ?? {})) {
      if (key.startsWith(repo)) delete require.cache[key];
    }
    const mod = require(entry);
    const parseCsv = typeof mod === 'function' ? mod : mod?.parseCsv;
    if (typeof parseCsv !== 'function') return { error: 'index.js exports no callable parseCsv' };
    return { parseCsv };
  } catch (err) {
    return { error: `index.js failed to load: ${String(err?.message ?? err)}` };
  }
}

function correctness(repo) {
  const { parseCsv, error } = loadParser(repo);
  const total = CASES.reduce((n, c) => n + c[3], 0);
  if (error) {
    return { score: 0, passed: false, summary: error, metrics: { earned: 0, total, failures: [], error } };
  }

  let earned = 0;
  const failures = [];
  for (const [label, input, check, weight] of CASES) {
    let rows;
    try {
      rows = parseCsv(input)?.rows;
    } catch (err) {
      failures.push({ case: label, error: String(err?.message ?? err) });
      continue;
    }
    if (!Array.isArray(rows)) {
      failures.push({ case: label, error: 'parseCsv did not return { rows: [] }' });
      continue;
    }
    let ok = false;
    try {
      ok = Boolean(check(rows));
    } catch (err) {
      failures.push({ case: label, error: String(err?.message ?? err) });
      continue;
    }
    if (ok) earned += weight;
    else failures.push({ case: label, got: JSON.stringify(rows).slice(0, 160) });
  }

  const score = Number((earned / total).toFixed(4));
  return {
    score,
    passed: score === 1,
    summary: `hidden suite: ${earned}/${total} weighted`,
    metrics: { earned, total, failures },
  };
}

/**
 * The consumer programs, which are the package's public contract.
 *
 * Their expected output is what the *shipped* code produced. A run that changes
 * empty-field semantics to match the README will fail the last of these — by
 * design, and recording that decision is what the `ambiguity` axis rewards.
 */
const CONSUMER_CASES = [
  {
    name: 'tally',
    file: 'consumers/tally.js',
    call: (m, csv) => m.tally(csv, 'city'),
    input: 'name,city\nada,london\ngrace,london\nalan,derby\n',
    expected: 'derby=1\nlondon=2',
  },
  {
    name: 'report',
    file: 'consumers/report.js',
    call: (m, csv) => m.report(csv),
    input: 'name,city\nada,london\n',
    expected: 'name: ada; city: london',
  },
  {
    name: 'filter',
    file: 'consumers/filter.js',
    call: (m, csv) => m.filter(csv, 'city', 'london'),
    input: 'name,city\nada,london\nalan,derby\n',
    expected: 'name,city\nada,london',
  },
  {
    name: 'report with an empty field',
    file: 'consumers/report.js',
    call: (m, csv) => m.report(csv),
    input: 'name,city\nada,\n',
    expected: 'name: ada; city: ',
  },
];

function regression(repo) {
  const require = createRequire(import.meta.url);
  const results = [];
  let passed = 0;

  for (const c of CONSUMER_CASES) {
    const path = join(repo, c.file);
    if (!existsSync(path)) {
      results.push({ case: c.name, error: `${c.file} is missing` });
      continue;
    }
    try {
      for (const key of Object.keys(require.cache ?? {})) {
        if (key.startsWith(repo)) delete require.cache[key];
      }
      const actual = c.call(require(path), c.input);
      if (actual === c.expected) {
        passed += 1;
        results.push({ case: c.name, ok: true });
      } else {
        results.push({ case: c.name, ok: false, expected: c.expected, actual: String(actual).slice(0, 160) });
      }
    } catch (err) {
      results.push({ case: c.name, error: String(err?.message ?? err) });
    }
  }

  const score = Number((passed / CONSUMER_CASES.length).toFixed(4));
  return {
    score,
    passed: score === 1,
    summary: `consumers: ${passed}/${CONSUMER_CASES.length} unchanged`,
    metrics: { passed, total: CONSUMER_CASES.length, results },
  };
}

function performance(repo) {
  const bench = join(repo, 'bench', 'parse.js');
  if (!existsSync(bench)) {
    return { score: null, passed: false, summary: 'bench/parse.js is missing', metrics: {} };
  }
  const run = spawnSync('node', ['bench/parse.js'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, BENCH_ROWS: String(BENCH_ROWS), NODE_OPTIONS: '' },
  });
  if (run.status !== 0) {
    return {
      score: 0,
      passed: false,
      summary: 'the benchmark did not complete',
      metrics: { exitCode: run.status, tail: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-400) },
    };
  }

  let elapsedMs = null;
  try {
    elapsedMs = JSON.parse(String(run.stdout).trim().split('\n').pop()).elapsedMs;
  } catch {
    return { score: 0, passed: false, summary: 'the benchmark printed no timing', metrics: {} };
  }

  // Thresholds an order of magnitude apart, so ordinary timing noise cannot
  // move the score much: what is being detected is an algorithmic difference,
  // not a few milliseconds.
  let score;
  if (elapsedMs <= PERF_TARGET_MS) score = 1;
  else if (elapsedMs >= PERF_CEILING_MS) score = 0;
  else {
    const span = Math.log(PERF_CEILING_MS) - Math.log(PERF_TARGET_MS);
    score = (Math.log(PERF_CEILING_MS) - Math.log(elapsedMs)) / span;
  }
  score = Number(score.toFixed(4));

  return {
    score,
    passed: elapsedMs <= PERF_TARGET_MS,
    summary: `${elapsedMs}ms for ${BENCH_ROWS} records (target ${PERF_TARGET_MS}ms)`,
    metrics: { elapsedMs, targetMs: PERF_TARGET_MS, ceilingMs: PERF_CEILING_MS, rows: BENCH_ROWS },
  };
}

/**
 * Did the run notice that the README and the code disagree, and say what it
 * decided?
 *
 * Checked structurally rather than by asking a model: `spec_digest` identifies
 * a rubric, and a rubric that returns different numbers on re-run makes the
 * digest a lie. So this asks whether the note exists, names both readings, and
 * commits to one — not whether the reasoning is good.
 */
function ambiguity(repo) {
  const path = join(repo, 'NOTES.md');
  if (!existsSync(path)) {
    return { score: 0, passed: false, summary: 'no NOTES.md', metrics: { present: false } };
  }
  const text = readFileSync(path, 'utf8');
  const lower = text.toLowerCase();

  const namesBothReadings =
    /null/.test(lower) && /(empty string|''|""|`''`|empty field)/.test(lower);
  const statesADecision =
    /(decid|chose|chosen|kept|keeping|opted|we will|i will|going with|left as|preserv)/.test(lower);

  const score = namesBothReadings && statesADecision ? 1 : namesBothReadings || statesADecision ? 0.5 : 0;
  return {
    score,
    passed: score === 1,
    summary:
      score === 1
        ? 'NOTES.md names both readings and records a decision'
        : score === 0.5
          ? 'NOTES.md is present but does not both name the conflict and decide it'
          : 'NOTES.md does not address the empty-field conflict',
    metrics: { present: true, namesBothReadings, statesADecision, bytes: text.length },
  };
}

function selfTests(repo) {
  const run = spawnSync('node', ['--test'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const ok = run.status === 0 && !/tests 0\b/.test(output);
  return {
    score: ok ? 1 : 0,
    passed: ok,
    summary: ok ? "the repo's own suite passed" : "the repo's own suite failed or shipped no tests",
    metrics: {
      exitCode: run.status,
      pass: Number(/^# pass (\d+)/m.exec(output)?.[1] ?? 0),
      fail: Number(/^# fail (\d+)/m.exec(output)?.[1] ?? 0),
      tail: output.split('\n').slice(-20).join('\n'),
    },
  };
}

const repo = resolve(process.argv[2]);
console.log(
  JSON.stringify({
    spec: {
      suite: 'csv-importer',
      cases: CASES.length,
      weightedTotal: CASES.reduce((n, c) => n + c[3], 0),
      consumers: CONSUMER_CASES.length,
      perfTargetMs: PERF_TARGET_MS,
      perfCeilingMs: PERF_CEILING_MS,
      benchRows: BENCH_ROWS,
      visibility: 'hidden from the agents',
    },
    axes: {
      correctness: correctness(repo),
      regression: regression(repo),
      performance: performance(repo),
      ambiguity: ambiguity(repo),
      'self-tests': selfTests(repo),
    },
  }),
);
