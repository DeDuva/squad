/**
 * The hidden acceptance suite for the ledger-summariser assignment.
 *
 * The trap in this task is float arithmetic. `0.1 + 0.2` in cents is `30`; in
 * dollars it is `30.000000000000004`, and an implementation that sums floats
 * and multiplies at the end passes every case a person would think to write by
 * hand. Those cases are in the edge subset, so a run that took the obvious
 * route is visible as a shape rather than as a slightly lower number.
 *
 *   acceptance   Every case, as a pass rate.
 *   edge-cases   Float accumulation, the `+` sign, tab separators, comments,
 *                three-decimal rejection, line numbering across skipped lines.
 *   api-shape    Returns the right keys with the right types, and survives
 *                non-string input.
 *   self-tests   The repository's own suite.
 *
 * Usage: node grader.mjs <work-repo> → JSON stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** [clause, input, check(summary) => true | string, isEdge] */
const CASES = [
  ['single record', '2026-01-05 groceries -12.34 USD', (s) => s.count === 1 && s.totalCents === -1234 || `count=${s.count} total=${s.totalCents}`, false],
  ['positive amount', '2026-01-05 pay 100.00 USD', (s) => s.totalCents === 10000 || `total=${s.totalCents}`, false],
  ['zero decimals', '2026-01-05 pay 100 USD', (s) => s.totalCents === 10000 || `total=${s.totalCents}`, false],
  ['one decimal', '2026-01-05 pay 10.5 USD', (s) => s.totalCents === 1050 || `total=${s.totalCents}`, false],
  ['leading plus', '2026-01-05 pay +10.50 USD', (s) => s.count === 1 && s.totalCents === 1050 || `count=${s.count} total=${s.totalCents}`, true],
  ['float accumulation stays exact', '2026-01-05 a 0.10 USD\n2026-01-05 b 0.20 USD', (s) => s.totalCents === 30 || `total=${s.totalCents}`, true],
  ['many small amounts stay exact', Array.from({ length: 10 }, () => '2026-01-05 x 0.07 USD').join('\n'), (s) => s.totalCents === 70 || `total=${s.totalCents}`, true],
  ['byCategory sums', '2026-01-05 food 1.00 USD\n2026-01-06 food 2.50 USD\n2026-01-07 rent 9.00 USD',
    (s) => s.byCategory?.food === 350 && s.byCategory?.rent === 900 || `byCategory=${JSON.stringify(s.byCategory)}`, false],
  ['currencies sorted and distinct', '2026-01-05 a 1.00 USD\n2026-01-05 b 1.00 EUR\n2026-01-05 c 1.00 USD',
    (s) => JSON.stringify(s.currencies) === '["EUR","USD"]' || `currencies=${JSON.stringify(s.currencies)}`, false],
  ['empty input', '', (s) => s.count === 0 && s.totalCents === 0 && JSON.stringify(s.errors) === '[]' || `got ${JSON.stringify(s)}`, false],
  ['blank lines skipped silently', '2026-01-05 a 1.00 USD\n\n   \n2026-01-06 b 1.00 USD',
    (s) => s.count === 2 && s.errors?.length === 0 || `count=${s.count} errors=${JSON.stringify(s.errors)}`, true],
  ['comment lines skipped silently', '# a note\n2026-01-05 a 1.00 USD',
    (s) => s.count === 1 && s.errors?.length === 0 || `count=${s.count} errors=${JSON.stringify(s.errors)}`, true],
  ['indented comment skipped', '   # indented\n2026-01-05 a 1.00 USD',
    (s) => s.count === 1 && s.errors?.length === 0 || `count=${s.count} errors=${JSON.stringify(s.errors)}`, true],
  ['runs of spaces are one separator', '2026-01-05    groceries    -12.34    USD', (s) => s.count === 1 && s.totalCents === -1234 || `count=${s.count} total=${s.totalCents}`, true],
  ['tabs are separators', '2026-01-05\tgroceries\t-12.34\tUSD', (s) => s.count === 1 && s.totalCents === -1234 || `count=${s.count} total=${s.totalCents}`, true],
  ['too few fields rejected', '2026-01-05 groceries -12.34', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['too many fields rejected', '2026-01-05 groceries -12.34 USD extra', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['bad date rejected', '2026-1-5 groceries -12.34 USD', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['three decimals rejected', '2026-01-05 groceries -12.345 USD', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, true],
  ['non-numeric amount rejected', '2026-01-05 groceries abc USD', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['lowercase currency rejected', '2026-01-05 groceries 1.00 usd', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['four-letter currency rejected', '2026-01-05 groceries 1.00 USDX', (s) => s.count === 0 && s.errors?.length === 1 || `count=${s.count} errors=${s.errors?.length}`, false],
  ['error line numbers count skipped lines', '# comment\n\n2026-01-05 bad\n2026-01-06 a 1.00 USD',
    (s) => s.errors?.[0]?.line === 3 || `first error line=${JSON.stringify(s.errors?.[0])}`, true],
  ['rejected line contributes nothing', '2026-01-05 food 1.00 USD\nbroken line here\n2026-01-06 food 2.00 USD',
    (s) => s.count === 2 && s.byCategory?.food === 300 && s.errors?.length === 1 || `count=${s.count} food=${s.byCategory?.food} errors=${s.errors?.length}`, false],
  ['negative and positive net out', '2026-01-05 a 10.00 USD\n2026-01-05 b -10.00 USD', (s) => s.totalCents === 0 || `total=${s.totalCents}`, false],
  ['trailing newline is not a record', '2026-01-05 a 1.00 USD\n', (s) => s.count === 1 && s.errors?.length === 0 || `count=${s.count} errors=${s.errors?.length}`, true],
  ['negative zero decimals', '2026-01-05 a -0.05 USD', (s) => s.totalCents === -5 || `total=${s.totalCents}`, true],
];

const BAD_INPUTS = [null, undefined, 42, {}, []];

const SPEC = {
  suite: 'ledger-acceptance',
  cases: CASES.length,
  edgeCases: CASES.filter((c) => c[3]).length,
  badInputs: BAD_INPUTS.length,
  visibility: 'hidden from the agents',
  selfTests: 'node --test, over whatever test files the run itself produced',
};

function load(repo) {
  const modulePath = join(repo, 'ledger.js');
  if (!existsSync(modulePath)) return { error: 'no ledger.js was delivered' };
  try {
    const require = createRequire(import.meta.url);
    const mod = require(modulePath);
    const fn = typeof mod === 'function' ? mod : mod?.summarise ?? mod?.summarize;
    if (typeof fn !== 'function') return { error: 'ledger.js exports no callable summarise' };
    return { fn };
  } catch (err) {
    return { error: `ledger.js failed to load: ${String(err?.message ?? err)}` };
  }
}

function runCases(fn) {
  return CASES.map(([clause, input, check, isEdge]) => {
    let outcome;
    try {
      const summary = fn(input);
      outcome = summary && typeof summary === 'object' ? check(summary) : `returned ${JSON.stringify(summary)}`;
    } catch (err) {
      outcome = `threw: ${String(err?.message ?? err)}`;
    }
    return { clause, isEdge, ok: outcome === true, detail: outcome === true ? undefined : String(outcome).slice(0, 160) };
  });
}

function score(results, predicate, label) {
  const subset = results.filter(predicate);
  const passed = subset.filter((r) => r.ok).length;
  const value = subset.length === 0 ? null : Number((passed / subset.length).toFixed(4));
  return {
    score: value,
    passed: value === 1,
    summary: `${label}: ${passed}/${subset.length} cases`,
    metrics: {
      total: subset.length,
      passed,
      failures: subset.filter((r) => !r.ok).slice(0, 12).map((r) => ({ clause: r.clause, detail: r.detail })),
    },
  };
}

function apiShape(fn) {
  const metrics = { keys_present: false, types_correct: false, survives_bad_input: 0, bad_input_total: BAD_INPUTS.length, notes: [] };
  try {
    const s = fn('2026-01-05 a 1.00 USD');
    const keys = ['count', 'totalCents', 'byCategory', 'currencies', 'errors'];
    metrics.keys_present = keys.every((k) => k in (s ?? {}));
    metrics.types_correct =
      typeof s?.count === 'number' &&
      typeof s?.totalCents === 'number' &&
      s?.byCategory && typeof s.byCategory === 'object' && !Array.isArray(s.byCategory) &&
      Array.isArray(s?.currencies) &&
      Array.isArray(s?.errors);
    if (!metrics.keys_present) metrics.notes.push(`keys were ${JSON.stringify(Object.keys(s ?? {}))}`);
  } catch (err) {
    metrics.notes.push(`threw on a valid ledger: ${String(err?.message ?? err)}`);
  }
  for (const bad of BAD_INPUTS) {
    try {
      const s = fn(bad);
      if (s && s.count === 0 && s.totalCents === 0) metrics.survives_bad_input += 1;
      else metrics.notes.push(`${String(bad)} returned ${JSON.stringify(s)?.slice(0, 80)}`);
    } catch (err) {
      metrics.notes.push(`${String(bad)} threw: ${String(err?.message ?? err)}`);
    }
  }
  const parts = [metrics.keys_present, metrics.types_correct, metrics.survives_bad_input === BAD_INPUTS.length];
  const value = Number((parts.filter(Boolean).length / parts.length).toFixed(4));
  return { score: value, passed: value === 1, summary: `api shape: ${parts.filter(Boolean).length}/${parts.length}`, metrics };
}

function selfTests(repo) {
  const run = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } });
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
const loaded = load(repo);
const zero = () => ({ score: 0, passed: false, summary: loaded.error, metrics: { load_error: loaded.error } });

const axes = loaded.error
  ? { acceptance: zero(), 'edge-cases': zero(), 'api-shape': zero(), 'self-tests': selfTests(repo) }
  : (() => {
      const results = runCases(loaded.fn);
      return {
        acceptance: score(results, () => true, 'hidden suite'),
        'edge-cases': score(results, (r) => r.isEdge, 'adversarial subset'),
        'api-shape': apiShape(loaded.fn),
        'self-tests': selfTests(repo),
      };
    })();

console.log(JSON.stringify({ spec: SPEC, axes }));
