/**
 * The hidden acceptance suite for the duration-parser assignment, plus the
 * repository's own tests, reported as two independent axes.
 *
 * Never shown to any squad and never written into their work repos: the agents
 * are scored on behaviour they had to derive from the brief, not on a test they
 * could read. Every variant is scored by this same file, which is what makes
 * "which vendor did better" a measurement rather than three self-reports.
 *
 * The two axes are deliberately not blended:
 *
 *   acceptance   Does the delivered module behave as the brief specified?
 *                Outcome effectiveness, measured by cases the agents never saw.
 *   self-tests   Does the repository's own suite pass?
 *                The agents wrote it. A run can implement the module perfectly
 *                and still ship a repo whose tests fail — two agents each
 *                producing something defensible that does not fit together.
 *                That is deliverable coherence, and it is not a property of
 *                the module.
 *
 * Usage: node grader.mjs <path-to-work-repo>  → JSON on stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Grouped by the brief's own clauses, so a failure names the part that was
// missed rather than just a count.
const CASES = [
  ['combined units', '1h30m', 5400],
  ['combined units', '1h30m15s', 5415],
  ['combined units', '2h15s', 7215],
  ['single unit h', '2h', 7200],
  ['single unit m', '5m', 300],
  ['single unit s', '90s', 90],
  ['bare integer is seconds', '45', 45],
  ['bare integer is seconds', '0', 0],
  ['whitespace ignored', '  1h30m  ', 5400],
  ['invalid: empty', '', null],
  ['invalid: whitespace only', '   ', null],
  ['invalid: unknown unit', '1x', null],
  ['invalid: unit with no value', 'h', null],
  ['invalid: trailing bare number', '1h30', null],
  ['invalid: negative', '-5m', null],
  ['invalid: non-string', 42, null],
  ['invalid: null input', null, null],
  ['invalid: undefined input', undefined, null],
  ['invalid: garbage', 'abc', null],
];

const SPEC = {
  suite: 'duration-acceptance',
  cases: CASES.length,
  visibility: 'hidden from the agents',
  selfTests: 'node --test, over whatever test files the run itself produced',
};

function acceptance(repo) {
  const modulePath = join(repo, 'duration.js');
  const metrics = {
    module_present: existsSync(modulePath),
    export_callable: false,
    total: CASES.length,
    passed: 0,
    failures: [],
    threw: [],
  };

  if (!metrics.module_present) {
    return { score: 0, passed: false, summary: 'no duration.js was delivered', metrics };
  }

  let parseDuration;
  try {
    const require = createRequire(import.meta.url);
    const mod = require(modulePath);
    // Either a bare function export or a named one — the brief says "exporting
    // parseDuration", and both readings are defensible.
    parseDuration = typeof mod === 'function' ? mod : mod?.parseDuration;
  } catch (err) {
    metrics.load_error = String(err?.message ?? err);
  }

  if (typeof parseDuration !== 'function') {
    return { score: 0, passed: false, summary: 'duration.js exports no callable parseDuration', metrics };
  }
  metrics.export_callable = true;

  for (const [clause, input, expected] of CASES) {
    let actual;
    try {
      actual = parseDuration(input);
    } catch (err) {
      // Throwing where the brief says "return null" is a real defect: a caller
      // following the contract would crash.
      metrics.threw.push({ clause, input: String(input), error: String(err?.message ?? err) });
      continue;
    }
    if (actual === expected) metrics.passed += 1;
    else metrics.failures.push({ clause, input: String(input), expected, actual: String(actual) });
  }

  const score = Number((metrics.passed / metrics.total).toFixed(4));
  return {
    score,
    passed: score === 1,
    summary: `hidden suite: ${metrics.passed}/${metrics.total} cases`,
    metrics,
  };
}

function selfTests(repo) {
  const run = spawnSync('node', ['--test'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  // No test files at all is a failure of the brief, which asked for tests —
  // but it is reported as a zero rather than as "did not apply", because the
  // absence is exactly what is being measured.
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
      tail: output.split('\n').slice(-25).join('\n'),
    },
  };
}

const repo = resolve(process.argv[2]);
console.log(JSON.stringify({ spec: SPEC, axes: { acceptance: acceptance(repo), 'self-tests': selfTests(repo) } }));
