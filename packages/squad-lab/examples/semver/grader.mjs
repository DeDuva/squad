/**
 * The hidden acceptance suite for the semver assignment.
 *
 * Chosen because the two other tasks saturate: a strong model writes a correct
 * CSV parser first try, and a suite everything scores 1.00 on measures nothing.
 * Semver has three traps that catch real implementations and are all in the
 * edge subset —
 *
 *   1. prerelease precedence (numeric < alphanumeric, longer list wins),
 *   2. caret on a zero major, where the boundary moves to minor and then patch,
 *   3. prerelease exclusion from ranges, which needs the comparator set to be
 *      consulted rather than each comparator independently.
 *
 *   acceptance   Every case.
 *   edge-cases   The three traps above, plus invalid input.
 *   api-shape    Both exports present, callable, right return types.
 *   self-tests   The repository's own suite.
 *
 * Usage: node grader.mjs <work-repo> → JSON stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// [clause, a, b, expected, isEdge]
const COMPARE = [
  ['major', '2.0.0', '1.0.0', 1, false],
  ['minor', '1.2.0', '1.1.0', 1, false],
  ['patch', '1.0.2', '1.0.1', 1, false],
  ['equal', '1.2.3', '1.2.3', 0, false],
  ['lower', '1.0.0', '2.0.0', -1, false],
  ['numeric not lexical', '1.0.10', '1.0.9', 1, true],
  ['leading v ignored', 'v1.2.3', '1.2.3', 0, false],
  ['build metadata ignored', '1.0.0+a', '1.0.0+b', 0, true],
  ['build metadata ignored vs bare', '1.0.0+x', '1.0.0', 0, true],
  ['prerelease below release', '1.0.0-alpha', '1.0.0', -1, false],
  ['prerelease chain alpha < alpha.1', '1.0.0-alpha', '1.0.0-alpha.1', -1, true],
  ['prerelease chain alpha.1 < alpha.beta', '1.0.0-alpha.1', '1.0.0-alpha.beta', -1, true],
  ['prerelease chain alpha.beta < beta', '1.0.0-alpha.beta', '1.0.0-beta', -1, true],
  ['prerelease chain beta < beta.2', '1.0.0-beta', '1.0.0-beta.2', -1, true],
  ['prerelease numeric ordering beta.2 < beta.11', '1.0.0-beta.2', '1.0.0-beta.11', -1, true],
  ['prerelease chain beta.11 < rc.1', '1.0.0-beta.11', '1.0.0-rc.1', -1, true],
  ['numeric identifier below alphanumeric', '1.0.0-1', '1.0.0-alpha', -1, true],
  ['equal prereleases', '1.0.0-rc.1', '1.0.0-rc.1', 0, false],
  ['invalid returns null', 'nope', '1.0.0', null, true],
  ['leading zero is invalid', '01.0.0', '1.0.0', null, true],
  ['missing patch is invalid', '1.2', '1.2.0', null, true],
  ['non-string is invalid', 42, '1.0.0', null, true],
];

// [clause, version, range, expected, isEdge]
const SATISFIES = [
  ['bare equals', '1.2.3', '1.2.3', true, false],
  ['bare equals false', '1.2.4', '1.2.3', false, false],
  ['gte', '1.5.0', '>=1.2.3', true, false],
  ['gte boundary', '1.2.3', '>=1.2.3', true, false],
  ['lt', '1.0.0', '<1.2.3', true, false],
  ['lt boundary excluded', '1.2.3', '<1.2.3', false, false],
  ['set requires all', '1.5.0', '>=1.0.0 <2.0.0', true, false],
  ['set requires all, fails one', '2.5.0', '>=1.0.0 <2.0.0', false, false],
  ['or matches second', '3.0.0', '1.x || >=3.0.0', true, false],
  ['or matches neither', '2.0.0', '>=3.0.0 || <1.0.0', false, false],
  ['star matches', '1.2.3', '*', true, false],
  ['empty range matches', '1.2.3', '', true, false],
  ['caret allows minor bump', '1.5.0', '^1.2.3', true, false],
  ['caret allows patch bump', '1.2.9', '^1.2.3', true, false],
  ['caret blocks major bump', '2.0.0', '^1.2.3', false, false],
  ['caret blocks below', '1.2.2', '^1.2.3', false, false],
  ['caret on zero major bounded by minor', '0.3.0', '^0.2.3', false, true],
  ['caret on zero major allows patch', '0.2.9', '^0.2.3', true, true],
  ['caret on zero-zero bounded by patch', '0.0.4', '^0.0.3', false, true],
  ['caret on zero-zero allows exact', '0.0.3', '^0.0.3', true, true],
  ['tilde allows patch', '1.2.9', '~1.2.3', true, false],
  ['tilde blocks minor', '1.3.0', '~1.2.3', false, true],
  ['tilde two-part', '1.2.0', '~1.2', true, true],
  ['tilde two-part blocks minor', '1.3.0', '~1.2', false, true],
  ['prerelease excluded from plain range', '1.2.3-alpha', '>=1.0.0', false, true],
  ['prerelease excluded from star', '1.2.3-alpha', '*', false, true],
  ['prerelease included when named', '1.2.3-alpha', '>=1.2.3-alpha', true, true],
  ['prerelease included when named, higher', '1.2.3-beta', '>=1.2.3-alpha', true, true],
  ['prerelease not included from other tuple', '1.2.4-alpha', '>=1.2.3-alpha', false, true],
  ['release still satisfies prerelease range', '1.2.4', '>=1.2.3-alpha', true, true],
  ['invalid version is false', 'nope', '>=1.0.0', false, true],
  ['invalid range is false', '1.0.0', 'not a range', false, true],
];

const SPEC = {
  suite: 'semver-acceptance',
  cases: COMPARE.length + SATISFIES.length,
  edgeCases: COMPARE.filter((c) => c[4]).length + SATISFIES.filter((c) => c[4]).length,
  visibility: 'hidden from the agents',
  selfTests: 'node --test, over whatever test files the run itself produced',
};

function load(repo) {
  const modulePath = join(repo, 'semver.js');
  if (!existsSync(modulePath)) return { error: 'no semver.js was delivered' };
  try {
    const require = createRequire(import.meta.url);
    const mod = require(modulePath);
    const compare = mod?.compare;
    const satisfies = mod?.satisfies;
    if (typeof compare !== 'function' || typeof satisfies !== 'function') {
      return { error: 'semver.js must export callable compare and satisfies' };
    }
    return { compare, satisfies };
  } catch (err) {
    return { error: `semver.js failed to load: ${String(err?.message ?? err)}` };
  }
}

function runCases({ compare, satisfies }) {
  const results = [];
  for (const [clause, a, b, expected, isEdge] of COMPARE) {
    let actual;
    let threw;
    try {
      actual = compare(a, b);
    } catch (err) {
      threw = String(err?.message ?? err);
    }
    results.push({
      clause: `compare: ${clause}`,
      isEdge,
      ok: threw === undefined && actual === expected,
      detail: threw ? `threw: ${threw}` : `compare(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${String(actual)}, expected ${String(expected)}`,
    });
  }
  for (const [clause, version, range, expected, isEdge] of SATISFIES) {
    let actual;
    let threw;
    try {
      actual = satisfies(version, range);
    } catch (err) {
      threw = String(err?.message ?? err);
    }
    results.push({
      clause: `satisfies: ${clause}`,
      isEdge,
      ok: threw === undefined && actual === expected,
      detail: threw ? `threw: ${threw}` : `satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)}) = ${String(actual)}, expected ${String(expected)}`,
    });
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
      failures: subset.filter((r) => !r.ok).slice(0, 14).map((r) => ({ clause: r.clause, detail: r.detail })),
    },
  };
}

function apiShape({ compare, satisfies }) {
  const metrics = { compare_returns_number: false, compare_returns_null: false, satisfies_returns_boolean: false, notes: [] };
  try {
    metrics.compare_returns_number = typeof compare('1.0.0', '2.0.0') === 'number';
    metrics.compare_returns_null = compare('garbage', '1.0.0') === null;
  } catch (err) {
    metrics.notes.push(`compare threw: ${String(err?.message ?? err)}`);
  }
  try {
    metrics.satisfies_returns_boolean = typeof satisfies('1.0.0', '>=1.0.0') === 'boolean';
  } catch (err) {
    metrics.notes.push(`satisfies threw: ${String(err?.message ?? err)}`);
  }
  const parts = [metrics.compare_returns_number, metrics.compare_returns_null, metrics.satisfies_returns_boolean];
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
      const results = runCases(loaded);
      return {
        acceptance: score(results, () => true, 'hidden suite'),
        'edge-cases': score(results, (r) => r.isEdge, 'adversarial subset'),
        'api-shape': apiShape(loaded),
        'self-tests': selfTests(repo),
      };
    })();

console.log(JSON.stringify({ spec: SPEC, axes }));
