/**
 * The hidden acceptance suite for the async-retry assignment.
 *
 * The interesting property of this task is that it is *observable without
 * waiting*. The brief requires `onRetry(error, attempt, delayMs)` to announce
 * the delay it is about to wait, so the backoff schedule can be asserted from
 * the reported numbers rather than by timing a real sleep. A grader that
 * measured elapsed milliseconds would be measuring the machine, and a study
 * built on it would report its own load as model variance.
 *
 * Every case uses `baseMs: 1` so a full run costs milliseconds.
 *
 *   acceptance   Every case, as a pass rate.
 *   edge-cases   Abort handling, `retries: 0`, `shouldRetry` short-circuit,
 *                the clamp — the parts a plausible-looking implementation
 *                gets wrong.
 *   api-shape    Returns a promise, resolves a value, rejects rather than
 *                throwing synchronously.
 *   self-tests   The repository's own suite.
 *
 * Usage: node grader.mjs <work-repo> → JSON stdout.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FAST = { baseMs: 1, factor: 2 };

/** A `fn` that fails `failures` times then resolves `value`. */
function flaky(failures, value = 'ok') {
  const calls = [];
  const fn = async (attempt) => {
    calls.push(attempt);
    if (calls.length <= failures) throw new Error(`boom ${calls.length}`);
    return value;
  };
  fn.calls = calls;
  return fn;
}

const collector = () => {
  const seen = [];
  const onRetry = (error, attempt, delayMs) => seen.push({ attempt, delayMs, message: String(error?.message ?? error) });
  return { seen, onRetry };
};

// Each case: [clause, isEdge, async (retry) => true | string-describing-failure]
const CASES = [
  ['resolves without retrying', false, async (retry) => {
    const fn = flaky(0, 'value');
    const out = await retry(fn, { ...FAST });
    return out === 'value' && fn.calls.length === 1 ? true : `got ${out} after ${fn.calls.length} call(s)`;
  }],
  ['retries until success', false, async (retry) => {
    const fn = flaky(2, 'late');
    const out = await retry(fn, { ...FAST });
    return out === 'late' && fn.calls.length === 3 ? true : `got ${out} after ${fn.calls.length} call(s)`;
  }],
  ['attempt number starts at 1 and increments', false, async (retry) => {
    const fn = flaky(2);
    await retry(fn, { ...FAST });
    return JSON.stringify(fn.calls) === '[1,2,3]' ? true : `attempts were ${JSON.stringify(fn.calls)}`;
  }],
  ['default is four attempts', false, async (retry) => {
    const fn = flaky(99);
    await retry(fn, { ...FAST }).catch(() => {});
    return fn.calls.length === 4 ? true : `made ${fn.calls.length} attempts, expected 4`;
  }],
  ['retries option controls attempts', false, async (retry) => {
    const fn = flaky(99);
    await retry(fn, { ...FAST, retries: 2 }).catch(() => {});
    return fn.calls.length === 3 ? true : `made ${fn.calls.length} attempts, expected 3`;
  }],
  ['retries: 0 calls once', true, async (retry) => {
    const fn = flaky(99);
    await retry(fn, { ...FAST, retries: 0 }).catch(() => {});
    return fn.calls.length === 1 ? true : `made ${fn.calls.length} attempts, expected 1`;
  }],
  ['rejects with the last error', false, async (retry) => {
    const fn = flaky(99);
    const err = await retry(fn, { ...FAST, retries: 2 }).then(() => null, (e) => e);
    return String(err?.message) === 'boom 3' ? true : `rejected with ${String(err?.message)}`;
  }],
  ['backoff schedule is base * factor ** n', true, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(99), { baseMs: 1, factor: 2, retries: 3, onRetry }).catch(() => {});
    const delays = seen.map((s) => s.delayMs);
    return JSON.stringify(delays) === '[1,2,4]' ? true : `delays were ${JSON.stringify(delays)}`;
  }],
  ['factor is honoured', true, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(99), { baseMs: 2, factor: 3, retries: 3, onRetry }).catch(() => {});
    const delays = seen.map((s) => s.delayMs);
    return JSON.stringify(delays) === '[2,6,18]' ? true : `delays were ${JSON.stringify(delays)}`;
  }],
  ['maxDelayMs clamps the schedule', true, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(99), { baseMs: 1, factor: 10, retries: 3, maxDelayMs: 5, onRetry }).catch(() => {});
    const delays = seen.map((s) => s.delayMs);
    return JSON.stringify(delays) === '[1,5,5]' ? true : `delays were ${JSON.stringify(delays)}`;
  }],
  ['onRetry is not called after the final failure', true, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(99), { ...FAST, retries: 2, onRetry }).catch(() => {});
    return seen.length === 2 ? true : `onRetry fired ${seen.length} time(s), expected 2`;
  }],
  ['onRetry receives the failing attempt number', true, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(99), { ...FAST, retries: 2, onRetry }).catch(() => {});
    return JSON.stringify(seen.map((s) => s.attempt)) === '[1,2]' ? true : `attempts were ${JSON.stringify(seen.map((s) => s.attempt))}`;
  }],
  ['onRetry is not called on success', false, async (retry) => {
    const { seen, onRetry } = collector();
    await retry(flaky(0), { ...FAST, onRetry });
    return seen.length === 0 ? true : `onRetry fired ${seen.length} time(s)`;
  }],
  ['shouldRetry false stops immediately', true, async (retry) => {
    const fn = flaky(99);
    await retry(fn, { ...FAST, shouldRetry: () => false }).catch(() => {});
    return fn.calls.length === 1 ? true : `made ${fn.calls.length} attempts, expected 1`;
  }],
  ['shouldRetry receives error and attempt', true, async (retry) => {
    const seen = [];
    const fn = flaky(99);
    await retry(fn, { ...FAST, retries: 2, shouldRetry: (e, a) => { seen.push([String(e?.message), a]); return true; } }).catch(() => {});
    return JSON.stringify(seen.map((s) => s[1])) === '[1,2]' ? true : `shouldRetry saw ${JSON.stringify(seen)}`;
  }],
  ['shouldRetry rejects with the triggering error', true, async (retry) => {
    const err = await retry(flaky(99), { ...FAST, shouldRetry: () => false }).then(() => null, (e) => e);
    return String(err?.message) === 'boom 1' ? true : `rejected with ${String(err?.message)}`;
  }],
  ['already-aborted signal never calls fn', true, async (retry) => {
    const fn = flaky(0);
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    await retry(fn, { ...FAST, signal: controller.signal }).catch(() => {});
    return fn.calls.length === 0 ? true : `fn was called ${fn.calls.length} time(s)`;
  }],
  ['already-aborted signal rejects with the reason', true, async (retry) => {
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    const err = await retry(flaky(0), { ...FAST, signal: controller.signal }).then(() => null, (e) => e);
    return String(err?.message) === 'stop now' ? true : `rejected with ${String(err?.message)}`;
  }],
  ['abort during the wait stops further attempts', true, async (retry) => {
    const controller = new AbortController();
    const fn = flaky(99);
    const promise = retry(fn, { baseMs: 40, factor: 1, retries: 5, signal: controller.signal }).catch(() => {});
    // Abort while the first backoff is in flight.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new Error('cancelled'));
    await promise;
    await new Promise((r) => setTimeout(r, 60));
    return fn.calls.length === 1 ? true : `fn was called ${fn.calls.length} time(s) after abort`;
  }],
  ['a thrown non-Error still retries', false, async (retry) => {
    let n = 0;
    const fn = async () => { n += 1; if (n < 2) throw 'plain string'; return 'ok'; };
    const out = await retry(fn, { ...FAST });
    return out === 'ok' && n === 2 ? true : `got ${out} after ${n} call(s)`;
  }],
];

const SPEC = {
  suite: 'retry-acceptance',
  cases: CASES.length,
  edgeCases: CASES.filter((c) => c[1]).length,
  visibility: 'hidden from the agents',
  selfTests: 'node --test, over whatever test files the run itself produced',
};

function load(repo) {
  const modulePath = join(repo, 'retry.js');
  if (!existsSync(modulePath)) return { error: 'no retry.js was delivered' };
  try {
    const require = createRequire(import.meta.url);
    const mod = require(modulePath);
    const fn = typeof mod === 'function' ? mod : mod?.retry;
    if (typeof fn !== 'function') return { error: 'retry.js exports no callable retry' };
    return { fn };
  } catch (err) {
    return { error: `retry.js failed to load: ${String(err?.message ?? err)}` };
  }
}

async function runCases(retry) {
  const results = [];
  for (const [clause, isEdge, body] of CASES) {
    let outcome;
    try {
      // A case that hangs must not hang the study.
      outcome = await Promise.race([
        body(retry),
        new Promise((r) => setTimeout(() => r('timed out after 5s'), 5000)),
      ]);
    } catch (err) {
      outcome = `threw: ${String(err?.message ?? err)}`;
    }
    results.push({ clause, isEdge, ok: outcome === true, detail: outcome === true ? undefined : String(outcome) });
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
      failures: subset.filter((r) => !r.ok).slice(0, 12).map((r) => ({ clause: r.clause, detail: r.detail })),
    },
  };
}

async function apiShape(retry) {
  const metrics = { returns_promise: false, resolves_value: false, rejects_not_throws: false };
  try {
    const p = retry(async () => 'x', { ...FAST });
    metrics.returns_promise = typeof p?.then === 'function';
    metrics.resolves_value = (await p) === 'x';
  } catch (err) {
    metrics.error = String(err?.message ?? err);
  }
  try {
    // Must reject, not throw synchronously — a caller writing `.catch()` on the
    // returned promise would otherwise never see it.
    const p = retry(async () => { throw new Error('always'); }, { ...FAST, retries: 0 });
    await p.then(() => {}, () => {});
    metrics.rejects_not_throws = true;
  } catch {
    metrics.rejects_not_throws = false;
  }
  const parts = [metrics.returns_promise, metrics.resolves_value, metrics.rejects_not_throws];
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
  : await (async () => {
      const results = await runCases(loaded.fn);
      return {
        acceptance: score(results, () => true, 'hidden suite'),
        'edge-cases': score(results, (r) => r.isEdge, 'adversarial subset'),
        'api-shape': await apiShape(loaded.fn),
        'self-tests': selfTests(repo),
      };
    })();

console.log(JSON.stringify({ spec: SPEC, axes }));
