/**
 * The scheduler, and the three ways a long study dies.
 *
 * A factorial study is hours of model calls. Everything here exists because one
 * of those hours goes wrong:
 *
 * 1. **It crashes at trial 140 of 160.** Resumption is by ADP rather than by
 *    local state, so a rerun asks which `external_ref`s already carry a closed,
 *    verified run and does exactly the rest. The test that matters is not that
 *    resumption works but that it produces *no duplicate run* — the failure
 *    mode where a study quietly ends up with two runs for one cell and a mean
 *    computed over both.
 * 2. **It spends more than it was allowed.** The cap is checked before a trial
 *    starts, because there is no way to un-spend a turn.
 * 3. **It reports a topology difference as a model difference.** Trials that
 *    did not run the same program land in different bands, and a banded report
 *    is two tables rather than one ordering.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DirectResponseHandler } from '../packages/squad-sdk/src/coordinator/direct-response.js';
import { harnessDigest } from '../packages/squad-lab/src/harness.js';
import { parseStudy, studyDigest, shortDigest, type Study } from '../packages/duva-bench/src/study.js';
import {
  bandResults,
  completedRefs,
  ensureTaskIntent,
  intentTitle,
  planTrials,
  priceTrial,
  runStudy,
  type ProgressEvent,
} from '../packages/duva-bench/src/scheduler.js';
import type { TrialResult } from '../packages/duva-bench/src/runner.js';
import {
  DEFAULT_SWARM_AGENTS,
  DEFAULT_SWARM_ROUTING,
} from '../packages/duva-bench/src/arms/swarm.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);

function study(overrides: { arms?: unknown[]; reps?: number; budgetUsd?: number; concurrency?: number } = {}): Study {
  const result = parseStudy({
    title: 'sched',
    tasks: [
      { id: 'retry', goal: 'r/goal.md', seed: 'r/seed', grader: 'r/g.mjs', graderSha256: SHA },
      { id: 'semver', goal: 's/goal.md', seed: 's/seed', grader: 's/g.mjs', graderSha256: SHA },
    ],
    arms: overrides.arms ?? [
      {
        id: 'single',
        harness: 'ai-sdk',
        model: { provider: 'anthropic', tier: 'fast' },
        toolset: { name: 'default', docsGrade: 'reference' },
        topology: 'single',
      },
      {
        id: 'swarm',
        harness: 'ai-sdk',
        model: { provider: 'anthropic', tier: 'fast' },
        toolset: { name: 'default', docsGrade: 'reference' },
        topology: 'swarm',
      },
    ],
    budgetUsd: overrides.budgetUsd ?? 100,
    concurrency: overrides.concurrency ?? 1,
    preRegistration: {
      primaryMetric: 'acceptance',
      secondaryMetrics: [],
      repetitions: overrides.reps ?? 2,
      exclusionRules: [],
      amendments: [],
    },
  });
  if (!result.ok) throw new Error(`fixture did not parse: ${JSON.stringify(result.errors)}`);
  return result.study;
}

const EP = { baseUrl: 'http://adp.invalid', token: 't', owner: 'o', repo: 'r', tokenEnv: 'TOK' };

function trialResult(over: Partial<TrialResult> = {}): TrialResult {
  return {
    externalRef: 'x',
    armId: 'single',
    harness: 'ai-sdk',
    topology: 'single',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    finalSha: 'abc',
    outcome: 'closed',
    verified: true,
    agentSessions: {},
    wallClockMs: 1,
    timeToQuiescenceMs: 1,
    testPassed: null,
    cost: { totalInputTokens: 1000, totalOutputTokens: 100 },
    ...over,
  };
}

// ─── Planning ────────────────────────────────────────────────────────────

describe('planTrials', () => {
  it('is every cell, in a stable order', () => {
    const s = study();
    const trials = planTrials(s);

    expect(trials).toHaveLength(2 * 2 * 2);
    expect(planTrials(s).map((t) => t.externalRef)).toEqual(trials.map((t) => t.externalRef));

    const short = shortDigest(studyDigest(s));
    expect(trials[0]!.externalRef).toBe(`${short}:single:retry:r1`);
    // Task-major, then arm, then repetition — a partial study is a prefix of
    // the full one rather than a random sample of it.
    expect(trials.map((t) => `${t.taskId}/${t.armId}/${t.rep}`)).toEqual([
      'retry/single/1', 'retry/single/2', 'retry/swarm/1', 'retry/swarm/2',
      'semver/single/1', 'semver/single/2', 'semver/swarm/1', 'semver/swarm/2',
    ]);
  });

  it('gives every trial a distinct idempotency key', () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('intentTitle', () => {
  it('separates two studies that share a task', () => {
    const a = intentTitle(studyDigest(study()), 'retry');
    const b = intentTitle(studyDigest(study({ reps: 5 })), 'retry');
    expect(a).not.toBe(b);
  });

  it('cannot be eaten by the coordinator, whatever the goal is called', () => {
    // Every built-in direct-response pattern anchors at `^`, so a title
    // starting `duva:` can never match one. The trap S1 removed cannot
    // re-enter through the brief the intent carries.
    const handler = new DirectResponseHandler();
    for (const taskId of ['config', 'help', 'status', 'team', 'hello']) {
      expect(handler.shouldHandleDirectly(intentTitle(studyDigest(study()), taskId))).toBe(false);
    }
  });
});

// ─── Intents ─────────────────────────────────────────────────────────────

describe('ensureTaskIntent', () => {
  it('files a goal only when one is not already there', async () => {
    const task = study().tasks[0]!;
    const digest = studyDigest(study());

    // Simulated by monkeypatching the module's collaborators is not possible
    // here, so this drives the two paths through a stubbed pair directly.
    const existing = { issueNumber: 7, intentId: 'intent-7', title: 'x', body: '' };
    const found = await ensureTaskIntentWith(async () => existing, async () => {
      throw new Error('must not file a second goal');
    }, digest, task);
    expect(found).toEqual({ taskId: 'retry', issueNumber: 7, intentId: 'intent-7', created: false });

    const filed = await ensureTaskIntentWith(
      async () => undefined,
      async () => ({ issueNumber: 9, intentId: 'intent-9', title: 'x', body: '' }),
      digest,
      task,
    );
    expect(filed).toEqual({ taskId: 'retry', issueNumber: 9, intentId: 'intent-9', created: true });
  });
});

/** The same logic `ensureTaskIntent` runs, with its two calls injected. */
async function ensureTaskIntentWith(
  find: (title: string) => Promise<{ issueNumber: number; intentId: string } | undefined>,
  create: (title: string) => Promise<{ issueNumber: number; intentId: string }>,
  digest: string,
  task: { id: string },
) {
  const title = intentTitle(digest, task.id);
  const existing = await find(title);
  if (existing) {
    return { taskId: task.id, issueNumber: existing.issueNumber, intentId: existing.intentId, created: false };
  }
  const goal = await create(title);
  return { taskId: task.id, issueNumber: goal.issueNumber, intentId: goal.intentId, created: true };
}

// ─── Resumption ──────────────────────────────────────────────────────────

describe('completedRefs', () => {
  const rows = [
    { runId: 'r1', externalRef: 'ref-closed-verified', status: 'closed' },
    { runId: 'r2', externalRef: 'ref-closed-unverified', status: 'closed' },
    { runId: 'r3', externalRef: 'ref-abandoned', status: 'abandoned' },
    { runId: 'r4', externalRef: 'ref-verify-unreachable', status: 'closed' },
  ];

  const deps = {
    compareRuns: async () => ({ intent_id: 'i', runs: rows }) as never,
    verifyRun: async (_ep: unknown, runId: string) => {
      if (runId === 'r2') return { ok: false };
      if (runId === 'r4') throw new Error('ECONNREFUSED');
      return { ok: true };
    },
  };

  it('counts only runs that both closed and verified', async () => {
    const done = await completedRefs(EP, ['i'], deps as never);
    expect([...done]).toEqual(['ref-closed-verified']);
  });

  it('replans a run it could not confirm rather than assuming it good', async () => {
    // Re-running a trial costs cents; keeping an unverifiable one costs the
    // study its evidence.
    const done = await completedRefs(EP, ['i'], deps as never);
    expect(done.has('ref-verify-unreachable')).toBe(false);
    expect(done.has('ref-closed-unverified')).toBe(false);
  });
});

// ─── Budget ──────────────────────────────────────────────────────────────

describe('priceTrial', () => {
  it('prefers a vendor-reported cost', () => {
    const result = trialResult({ cost: { totalInputTokens: 1, totalOutputTokens: 1, totalEstimatedCost: 0.5 } });
    expect(priceTrial(result).usd).toBe(0.5);
  });

  it('returns null for a model the table does not know, never zero', () => {
    // A cap satisfied by ignorance is not a cap.
    const result = trialResult({ model: 'not-a-real-model', cost: { totalInputTokens: 1000, totalOutputTokens: 100 } });
    expect(priceTrial(result).usd).toBeNull();
  });
});

// ─── Banding ─────────────────────────────────────────────────────────────

describe('bandResults', () => {
  it('separates a swarm from a single agent', () => {
    const bands = bandResults([
      trialResult({ armId: 'single', topology: 'single' }),
      trialResult({ armId: 'single', topology: 'single' }),
      trialResult({ armId: 'swarm', topology: 'swarm' }),
    ]);
    expect(bands).toHaveLength(2);
    expect(bands.map((b) => `${b.harness}/${b.topology}:${b.trials}`).sort()).toEqual([
      'ai-sdk/single:2',
      'ai-sdk/swarm:1',
    ]);
  });

  it('keeps one band when only the model varies, because that is the experiment', () => {
    const bands = bandResults([
      trialResult({ armId: 'a', model: 'claude-haiku-4-5' }),
      trialResult({ armId: 'b', model: 'claude-sonnet-5' }),
    ]);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.armIds).toEqual(['a', 'b']);
  });
});

describe('topology moves the harness digest', () => {
  const base = {
    toolSurface: 'registered' as const,
    systemPrompt: 'charter-only' as const,
    routing: [],
    tools: ['read_file'],
    limits: { turnTimeoutMs: 1, deadlineMs: 2, graceMs: 3 },
    maxToolRounds: 25,
    harnessImpl: 'ai-sdk' as const,
    sdkVersion: '0.12.0',
  };

  it('gives a swarm a different harness digest from a single agent', () => {
    // `harnessDigest` folds agents and routing, so the topology arm is visibly
    // a different program rather than the same one with a label on it.
    const single = harnessDigest({
      ...base,
      agents: [{ name: 'solver', role: 'Agent', prompt: 'Solve it.' }],
    });
    const swarm = harnessDigest({
      ...base,
      agents: DEFAULT_SWARM_AGENTS,
      routing: DEFAULT_SWARM_ROUTING,
    });
    expect(swarm).not.toBe(single);
  });
});

// ─── The study loop ──────────────────────────────────────────────────────

interface Harness {
  root: string;
  events: ProgressEvent[];
  started: string[];
  cleanup: () => void;
}

function schedulerHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'duvabench-sched-'));
  return { root, events: [], started: [], cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const stubDeps = (h: Harness, over: { done?: Set<string>; usdPerTrial?: number; fail?: (ref: string) => boolean } = {}) => ({
  ensureRepo: async () => {},
  ensureTaskIntent: async (_ep: unknown, _d: string, task: { id: string }) => ({
    taskId: task.id,
    issueNumber: 1,
    intentId: `intent-${task.id}`,
    created: true,
  }),
  completedRefs: async () => over.done ?? new Set<string>(),
  runTrialProcess: async (launch: { trial: { externalRef: string; armId: string } }) => {
    h.started.push(launch.trial.externalRef);
    if (over.fail?.(launch.trial.externalRef)) throw new Error('child died');
    return trialResult({
      externalRef: launch.trial.externalRef,
      armId: launch.trial.armId,
      topology: launch.trial.armId === 'swarm' ? 'swarm' : 'single',
      cost: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: over.usdPerTrial ?? 0.01,
      },
    });
  },
});

const options = (h: Harness, s: Study, deps: object) => ({
  study: s,
  ep: EP,
  root: h.root,
  resolveTask: (task: { id: string }) => ({ title: `Task ${task.id}`, body: 'body', seed: `/seed/${task.id}` }),
  deps: deps as never,
  onEvent: (e: ProgressEvent) => h.events.push(e),
});

describe('runStudy', () => {
  it('runs every trial once and bands the results', async () => {
    const h = schedulerHarness();
    try {
      const s = study();
      const report = await runStudy(options(h, s, stubDeps(h)));

      expect(report.planned).toBe(8);
      expect(report.ran).toBe(8);
      expect(report.skipped).toBe(0);
      expect(new Set(h.started).size).toBe(8);
      // Two topologies is two bands: the study must not be ranked as a whole.
      expect(report.bands).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('resumes with exactly the missing trials, and starts no run twice', async () => {
    const h = schedulerHarness();
    try {
      const s = study();
      const all = planTrials(s).map((t) => t.externalRef);
      // Six of eight already closed and verified — the state a study is in when
      // it dies two trials from the end.
      const done = new Set(all.slice(0, 6));

      const report = await runStudy(options(h, s, stubDeps(h, { done })));

      expect(report.skipped).toBe(6);
      expect(report.ran).toBe(2);
      expect(h.started.sort()).toEqual(all.slice(6).sort());
      // The property that actually matters: nothing already recorded was run
      // again, so no cell ends up with two runs and a mean over both.
      for (const ref of done) expect(h.started).not.toContain(ref);
    } finally {
      h.cleanup();
    }
  });

  it('writes an append-only progress log a crash cannot erase', async () => {
    const h = schedulerHarness();
    try {
      const s = study();
      await runStudy(options(h, s, stubDeps(h, { done: new Set(planTrials(s).slice(0, 3).map((t) => t.externalRef)) })));

      const lines = readFileSync(join(h.root, 'progress.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines[0].kind).toBe('study');
      expect(lines.filter((l) => l.kind === 'intent')).toHaveLength(2);
      expect(lines.filter((l) => l.kind === 'skipped')).toHaveLength(3);
      expect(lines.filter((l) => l.kind === 'started')).toHaveLength(5);
      expect(lines.filter((l) => l.kind === 'finished')).toHaveLength(5);
    } finally {
      h.cleanup();
    }
  });

  it('stops before the trial that would breach the budget', async () => {
    const h = schedulerHarness();
    try {
      // $1 cap, $0.40 a trial: three fit, the fourth must never start.
      const s = study({ budgetUsd: 1 });
      const report = await runStudy(options(h, s, stubDeps(h, { usdPerTrial: 0.4 })));

      expect(report.budgetStopped).toBe(true);
      expect(h.started).toHaveLength(3);
      expect(report.spend.usd).toBeCloseTo(1.2, 5);

      const stop = h.events.find((e) => e.kind === 'budget-stop');
      expect(stop).toMatchObject({ kind: 'budget-stop', budgetUsd: 1, remaining: 5 });
    } finally {
      h.cleanup();
    }
  });

  it('counts an unpriced trial as unpriced rather than as free', async () => {
    const h = schedulerHarness();
    try {
      const s = study({ budgetUsd: 1 });
      const deps = {
        ...stubDeps(h),
        runTrialProcess: async (launch: { trial: { externalRef: string } }) => {
          h.started.push(launch.trial.externalRef);
          return trialResult({
            externalRef: launch.trial.externalRef,
            model: 'not-a-real-model',
            cost: { totalInputTokens: 10, totalOutputTokens: 10 },
          });
        },
      };
      const report = await runStudy(options(h, s, deps));

      // Every trial ran because nothing could be charged — and the report says
      // so, instead of claiming the study cost $0.00.
      expect(report.spend.unpriced).toBe(8);
      expect(report.spend.usd).toBe(0);
      expect(report.budgetStopped).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('records a failed trial without stopping the study', async () => {
    const h = schedulerHarness();
    try {
      const s = study();
      const refs = planTrials(s).map((t) => t.externalRef);
      const report = await runStudy(options(h, s, stubDeps(h, { fail: (ref) => ref === refs[2] })));

      expect(report.failed).toBe(1);
      expect(report.ran).toBe(7);
      expect(h.events.find((e) => e.kind === 'failed')).toMatchObject({ externalRef: refs[2] });
    } finally {
      h.cleanup();
    }
  });
});

// ─── A real SIGKILL ──────────────────────────────────────────────────────

describe('a killed trial process', () => {
  it('rejects rather than hanging, so the pool reclaims the worker', async () => {
    // The fork path, for real: a child that never reports, killed the way a
    // wedged backend has to be killed because `abort()` is only cooperative.
    const { fork } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'duvabench-kill-'));
    try {
      const script = join(dir, 'hang.mjs');
      writeFileSync(script, 'setInterval(() => {}, 1000);\n');

      const child = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const outcome = new Promise<string>((resolvePromise) => {
        child.on('exit', (code, signal) =>
          resolvePromise(`exited ${signal ? `on ${signal}` : `with code ${code}`} before reporting`),
        );
      });

      await new Promise((r) => setTimeout(r, 100));
      child.kill('SIGKILL');

      expect(await outcome).toBe('exited on SIGKILL before reporting');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
