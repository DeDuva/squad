/**
 * The hidden acceptance suite for the CSV-parser assignment.
 *
 * Four axes, deliberately not blended, because the whole point of the study is
 * that they disagree:
 *
 *   acceptance   Every case, as a pass rate. The headline.
 *   edge-cases   The adversarial subset only — embedded newlines, doubled
 *                quotes, the BOM, an unterminated field. A run can score well
 *                on `acceptance` purely by getting the common shapes right,
 *                and this is the axis that says so.
 *   api-shape    Does the export exist, is it callable, does it return an
 *                array, and does it survive garbage input without throwing?
 *                Measured separately because a module that throws on `null`
 *                scores zero on everything else for one reason, and a reader
 *                should be able to see which reason.
 *   self-tests   The repository's own suite. The agents wrote it.
 *
 * Never shown to any squad. Usage: node grader.mjs <work-repo> → JSON stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BOM = '﻿';

// [clause, input, expected, isEdge]
const CASES = [
  ['plain records', 'a,b\nc,d', [['a', 'b'], ['c', 'd']], false],
  ['single field', 'a', [['a']], false],
  ['single record no newline', 'a,b', [['a', 'b']], false],
  ['crlf endings', 'a,b\r\nc,d', [['a', 'b'], ['c', 'd']], false],
  ['mixed lf and crlf', 'a,b\r\nc,d\ne,f', [['a', 'b'], ['c', 'd'], ['e', 'f']], false],
  ['empty fields', 'a,,b', [['a', '', 'b']], false],
  ['lone comma is two empties', ',', [['', '']], false],
  ['trailing newline drops no record', 'a\nb\n', [['a'], ['b']], false],
  ['trailing crlf drops no record', 'a\r\nb\r\n', [['a'], ['b']], false],
  ['empty document', '', [], false],
  ['quoted simple', '"a","b"', [['a', 'b']], false],
  ['quoted with comma', '"a,b",c', [['a,b', 'c']], true],
  ['quoted with newline', '"a\nb",c', [['a\nb', 'c']], true],
  ['quoted with crlf', '"a\r\nb",c', [['a\r\nb', 'c']], true],
  ['doubled quote is one quote', '"a""b"', [['a"b']], true],
  ['doubled quote alone', '""""', [['"']], true],
  ['quoted empty field', '"",a', [['', 'a']], true],
  ['quote mid unquoted field is literal', 'a"b,c', [['a"b', 'c']], true],
  ['unquoted spaces are preserved', ' a , b ', [[' a ', ' b ']], true],
  ['quoted field then unquoted', '"a",b\nc,"d"', [['a', 'b'], ['c', 'd']], false],
  ['blank line is one empty field', 'a\n\nb', [['a'], [''], ['b']], true],
  ['unterminated quote keeps what it read', 'a,"bc', [['a', 'bc']], true],
  ['unterminated quote with newline', 'a,"b\nc', [['a', 'b\nc']], true],
  ['bom stripped from first field only', `${BOM}a,b`, [['a', 'b']], true],
  ['bom not stripped later', `a,${BOM}b`, [['a', `${BOM}b`]], true],
  ['bom on second record untouched', `${BOM}a\n${BOM}b`, [['a'], [`${BOM}b`]], true],
  ['many fields', 'a,b,c,d,e', [['a', 'b', 'c', 'd', 'e']], false],
  ['quoted containing only comma', '","', [[',']], true],
  ['record of empties', ',,', [['', '', '']], false],
  ['quoted then empty', '"a",', [['a', '']], false],
];

const BAD_INPUTS = [null, undefined, 42, {}, [], true, Symbol('x')];

const SPEC = {
  suite: 'csvparse-acceptance',
  cases: CASES.length,
  edgeCases: CASES.filter((c) => c[3]).length,
  badInputs: BAD_INPUTS.length,
  visibility: 'hidden from the agents',
  selfTests: 'node --test, over whatever test files the run itself produced',
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v)?.slice(0, 120) ?? String(v);

function load(repo) {
  const modulePath = join(repo, 'csvparse.js');
  if (!existsSync(modulePath)) return { error: 'no csvparse.js was delivered' };
  try {
    const require = createRequire(import.meta.url);
    const mod = require(modulePath);
    const fn = typeof mod === 'function' ? mod : mod?.parseCsv;
    if (typeof fn !== 'function') return { error: 'csvparse.js exports no callable parseCsv' };
    return { fn };
  } catch (err) {
    return { error: `csvparse.js failed to load: ${String(err?.message ?? err)}` };
  }
}

/** One pass over the cases, reused by both scoring axes. */
function runCases(fn) {
  const results = [];
  for (const [clause, input, expected, isEdge] of CASES) {
    let actual;
    let threw;
    try {
      actual = fn(input);
    } catch (err) {
      threw = String(err?.message ?? err);
    }
    results.push({ clause, isEdge, ok: threw === undefined && same(actual, expected), threw, expected, actual });
  }
  return results;
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
      failures: subset
        .filter((r) => !r.ok)
        .slice(0, 12)
        .map((r) => ({ clause: r.clause, expected: show(r.expected), actual: r.threw ? `threw: ${r.threw}` : show(r.actual) })),
    },
  };
}

function apiShape(fn) {
  const metrics = { callable: true, returns_array: false, survives_bad_input: 0, bad_input_total: BAD_INPUTS.length, threw_on: [] };
  try {
    metrics.returns_array = Array.isArray(fn('a,b'));
  } catch (err) {
    metrics.threw_on.push({ input: "'a,b'", error: String(err?.message ?? err) });
  }
  for (const bad of BAD_INPUTS) {
    try {
      const out = fn(bad);
      if (Array.isArray(out) && out.length === 0) metrics.survives_bad_input += 1;
      else metrics.threw_on.push({ input: String(bad), error: `returned ${show(out)}, expected []` });
    } catch (err) {
      metrics.threw_on.push({ input: String(bad), error: String(err?.message ?? err) });
    }
  }
  // Two halves weighted equally: returning an array at all, and refusing to
  // throw on input the brief said returns `[]`.
  const value = Number(((Number(metrics.returns_array) + metrics.survives_bad_input / BAD_INPUTS.length) / 2).toFixed(4));
  return {
    score: value,
    passed: value === 1,
    summary: `api shape: array=${metrics.returns_array}, ${metrics.survives_bad_input}/${BAD_INPUTS.length} bad inputs handled`,
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

// A module that will not load scores zero on the behavioural axes and `null`
// on nothing: "did not deliver" is a measurement, not an absence of one.
const zero = (label) => ({ score: 0, passed: false, summary: loaded.error, metrics: { load_error: loaded.error } });

const axes = loaded.error
  ? {
      acceptance: zero(),
      'edge-cases': zero(),
      'api-shape': zero(),
      'self-tests': selfTests(repo),
    }
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
