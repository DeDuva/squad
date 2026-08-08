/**
 * Analysis, and the four ways a report can lie without being wrong.
 *
 * 1. **It can restate the scheduler instead of the record.** Everything here is
 *    read back from ADP, so the reconciliation test drives the collector with a
 *    known ADP and checks that every reported number is the source number —
 *    not a plausible one.
 * 2. **It can score a run nobody could verify.** A tampered or truncated run
 *    that lands as a 0 drags a mean down exactly as if the agent had tried and
 *    failed. So `/verify` not `ok` is the verdict `ERROR`, excluded from every
 *    statistic and counted out loud.
 * 3. **It can turn missing data into zero.** Unscored is unscored and unpriced
 *    is unpriced, in the numbers and in the rendering.
 * 4. **It can be irreproducible.** The statistics are seeded, so the same
 *    outcomes give the same answer.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

import {
  collectOutcomes,
  costLedger,
  includedTrials,
  noiseFloors,
  observationsOf,
  readTrajectory,
  summariseCells,
  toolSurfaceOf,
  type Outcomes,
} from '../packages/duva-bench/src/analysis.js';
import { buildReport, renderHtml } from '../packages/duva-bench/src/report.js';
import { parseStudy, type Study } from '../packages/duva-bench/src/study.js';
import { planTrials } from '../packages/duva-bench/src/scheduler.js';
import { generateTwin } from '../packages/duva-bench/src/twins.js';
import { defaultTools } from '../packages/squad-lab/src/tools/default.js';
import {
  pairedStats,
  pythonPath,
  StatsBridgeUnavailable,
} from '../packages/duva-bench/src/stats-bridge.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);
const EP = { baseUrl: 'http://adp.invalid', token: 't', owner: 'o', repo: 'r' };

function study(): Study {
  const parsed = parseStudy({
    title: 'analysis',
    tasks: [{ id: 'retry', goal: 'g.md', seed: 'seed', grader: 'g.mjs', graderSha256: SHA }],
    arms: [
      {
        id: 'standard',
        harness: 'ai-sdk',
        model: { provider: 'anthropic', tier: 'fast' },
        toolset: { name: 'default', docsGrade: 'reference' },
        topology: 'single',
      },
      {
        id: 'twin',
        harness: 'ai-sdk',
        model: { provider: 'anthropic', tier: 'fast' },
        toolset: { name: 'default', docsGrade: 'rich', twinSeed: 'study-a' },
        topology: 'single',
      },
    ],
    budgetUsd: 5,
    concurrency: 1,
    preRegistration: {
      primaryMetric: 'acceptance',
      secondaryMetrics: [],
      repetitions: 2,
      exclusionRules: [{ id: 'unverified-run', description: 'verify not ok' }],
      amendments: [],
    },
  });
  if (!parsed.ok) throw new Error('fixture did not parse');
  return parsed.study;
}

/** A stand-in ADP: fixed rows, fixed verdicts, fixed trajectories. */
function fakeAdp(over: { verified?: Record<string, boolean>; unscored?: string[] } = {}) {
  const s = study();
  const refs = planTrials(s).map((t) => t.externalRef);
  const twinNames = Object.values(generateTwin(defaultTools('/'), 'study-a').renameMap.tools);

  const rows = refs.map((ref, i) => ({
    runId: `run-${i}`,
    externalRef: ref,
    orchestrator: 'squad',
    status: 'closed',
    finalGitSha: `sha-${i}`,
    trajectoryDigest: `digest-${i}`,
    eval: null,
    evals: over.unscored?.includes(ref)
      ? [{ name: 'acceptance', score: null, passed: false, specDigest: 'sd', gateStatus: 'skipped' }]
      : [{ name: 'acceptance', score: 0.5 + i * 0.1, passed: i % 2 === 0, specDigest: 'sd', gateStatus: 'pass' }],
    labels: { model: 'claude-haiku-4-5', arm: ref.split(':')[1]! },
    events: 10 + i,
    tokensIn: 1000 + i,
    tokensOut: 100 + i,
    costMicroUsd: 5000 + i,
    durationMs: 2000 + i,
    toolCalls: 4,
    toolFailures: 1,
    createdAt: '2026-08-08T00:00:00Z',
    closedAt: '2026-08-08T00:01:00Z',
  }));

  const deps = {
    compareRuns: async () => ({ intent_id: 'i', runs: rows }) as never,
    verifyRun: async (_ep: unknown, runId: string) => {
      const ref = rows.find((r) => r.runId === runId)!.externalRef;
      const ok = over.verified?.[ref] ?? true;
      return { ok } as never;
    },
    runTrajectory: async (_ep: unknown, runId: string) => {
      const row = rows.find((r) => r.runId === runId)!;
      const isTwin = row.externalRef.includes(':twin:');
      // The twin arm calls its own tools; both arms also make one call to a
      // name neither surface has, which is the hallucination being measured.
      const names = isTwin ? twinNames : defaultTools('/').map((t) => t.name);
      return {
        events: [
          { kind: 'model_call', type: 'completion', status: 'success' },
          { kind: 'model_call', type: 'completion', status: 'success' },
          { kind: 'tool_call', type: names[0], status: 'success' },
          { kind: 'tool_call', type: names[1], status: 'success' },
          { kind: 'tool_call', type: names[2], status: 'failure' },
          { kind: 'tool_call', type: 'invented_tool', status: 'failure' },
        ],
      } as never;
    },
  };

  return { study: s, rows, deps, intents: new Map([['retry', 'i']]) };
}

const collect = async (fixture: ReturnType<typeof fakeAdp>): Promise<Outcomes> =>
  collectOutcomes(EP, fixture.study, fixture.intents, fixture.deps as never);

// ─── Reconciliation ──────────────────────────────────────────────────────

describe('every reported number comes from ADP', () => {
  it('reconciles each trial against the row it was read from', async () => {
    const fixture = fakeAdp();
    const outcomes = await collect(fixture);

    expect(outcomes.trials).toHaveLength(fixture.rows.length);
    for (const trial of outcomes.trials) {
      const row = fixture.rows.find((r) => r.externalRef === trial.externalRef)!;
      expect(trial.runId).toBe(row.runId);
      expect(trial.tokensIn).toBe(row.tokensIn);
      expect(trial.tokensOut).toBe(row.tokensOut);
      expect(trial.costMicroUsd).toBe(row.costMicroUsd);
      expect(trial.durationMs).toBe(row.durationMs);
      expect(trial.trajectoryDigest).toBe(row.trajectoryDigest);
      expect(trial.axes.acceptance).toBe(row.evals[0]!.score);
    }
  });

  it('takes tool and step counts from the trajectory, not the summary row', async () => {
    // The row says 4 tool calls and 1 failure; the trajectory says 4 and 2.
    // The trajectory is the record of what happened, so it wins.
    const outcomes = await collect(fakeAdp());
    for (const trial of outcomes.trials) {
      expect(trial.steps).toBe(2);
      expect(trial.toolCalls).toBe(4);
      expect(trial.toolFailures).toBe(2);
    }
  });

  it('ignores a run against this intent that the plan does not know about', async () => {
    const fixture = fakeAdp();
    const deps = {
      ...fixture.deps,
      compareRuns: async () =>
        ({
          intent_id: 'i',
          runs: [...fixture.rows, { ...fixture.rows[0]!, runId: 'stranger', externalRef: 'other-study:x:retry:r1' }],
        }) as never,
    };
    // Two studies can share a task. Folding a stranger's run into this one is
    // how a result stops being about what it says.
    const outcomes = await collectOutcomes(EP, fixture.study, fixture.intents, deps as never);
    expect(outcomes.trials.map((t) => t.runId)).not.toContain('stranger');
  });
});

// ─── The hallucinated-call rate ──────────────────────────────────────────

describe('hallucinated calls are judged against the arm that made them', () => {
  it('does not mark a twin arm wrong for using its own tools', async () => {
    const outcomes = await collect(fakeAdp());
    // Both arms made exactly one call outside their surface. If the twin arm
    // were judged against the standard names, all three of its calls would
    // count and the study would "find" an enormous effect that is an artefact.
    for (const trial of outcomes.trials) {
      expect(trial.hallucinatedNames).toEqual(['invented_tool']);
      expect(trial.hallucinatedCalls).toBe(1);
      expect(trial.hallucinatedCallRate).toBeCloseTo(0.25, 6);
    }
  });

  it('derives each arm surface from the spec, so an analysis needs no local state', () => {
    const [standard, twin] = study().arms;
    expect([...toolSurfaceOf(standard!)].sort()).toEqual(defaultTools('/').map((t) => t.name).sort());
    expect([...toolSurfaceOf(twin!)].sort()).toEqual(
      Object.values(generateTwin(defaultTools('/'), 'study-a').renameMap.tools).sort(),
    );
  });

  it('counts a call against an empty surface as hallucinated', () => {
    const read = readTrajectory(
      [{ kind: 'tool_call', type: 'anything', status: 'success' }],
      new Set<string>(),
    );
    expect(read.hallucinated).toEqual(['anything']);
  });
});

// ─── Evidence gating ─────────────────────────────────────────────────────

describe('a run ADP could not verify', () => {
  it('is ERROR, excluded and counted — never a zero', async () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    const outcomes = await collect(fakeAdp({ verified: { [refs[0]!]: false } }));

    const bad = outcomes.trials.find((t) => t.externalRef === refs[0]);
    expect(bad!.verdict).toBe('ERROR');
    expect(bad!.excludedBy).toBe('unverified-run');
    // The score it *did* receive is still on the record — it is excluded from
    // statistics, not erased, so a reader can see what was thrown away.
    expect(bad!.axes.acceptance).not.toBeNull();

    expect(includedTrials(outcomes)).toHaveLength(refs.length - 1);
    expect(outcomes.exclusions['unverified-run']).toBe(1);
  });

  it('keeps an unverifiable run out of every cell statistic', async () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    const outcomes = await collect(fakeAdp({ verified: { [refs[0]!]: false } }));
    const cells = summariseCells(outcomes, ['acceptance']);
    const total = cells.reduce((sum, c) => sum + c.n, 0);
    expect(total).toBe(refs.length - 1);
  });

  it('is reported as ERROR in the rendered page', async () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    const outcomes = await collect(fakeAdp({ verified: { [refs[0]!]: false } }));
    const html = renderHtml(
      buildReport({ study: study(), outcomes, noiseFloors: [], stats: {} }),
    );
    expect(html).toContain('ERROR');
    expect(html).toMatch(/1<\/span> excluded/);
  });
});

// ─── Missing data is not zero ────────────────────────────────────────────

describe('unscored and unpriced', () => {
  it('keeps an unscored axis null rather than folding it to zero', async () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    const outcomes = await collect(fakeAdp({ unscored: [refs[0]!] }));

    const trial = outcomes.trials.find((t) => t.externalRef === refs[0])!;
    expect(trial.axes.acceptance).toBeNull();
    expect(trial.axesPassed.acceptance).toBeNull();

    // And the cell mean is over the trials that were scored, not over a zero.
    const cell = summariseCells(outcomes, ['acceptance']).find((c) => c.armId === refs[0]!.split(':')[1]);
    expect(cell!.axes.acceptance?.n).toBeLessThan(cell!.n);
  });

  it('renders unscored and unpriced as words, never as numbers', async () => {
    const refs = planTrials(study()).map((t) => t.externalRef);
    const outcomes = await collect(fakeAdp({ unscored: [refs[0]!] }));
    outcomes.trials[0]!.costMicroUsd = null;

    const html = renderHtml(buildReport({ study: study(), outcomes, noiseFloors: [], stats: {} }));
    expect(html).toContain('unscored');
    expect(html).toContain('unpriced');
    expect(html).not.toContain('$0.0000');
  });

  it('leaves an unpriced trial out of the cost total rather than adding zero', async () => {
    const outcomes = await collect(fakeAdp());
    outcomes.trials[0]!.costMicroUsd = null;
    const ledger = costLedger(outcomes);
    expect(ledger.unpricedTrials).toBe(1);
    expect(ledger.pricedTrials).toBe(outcomes.trials.length - 1);
  });
});

// ─── Noise floor before contrast ─────────────────────────────────────────

describe('the noise floor', () => {
  it('is measured from repeated trials in the same cell', async () => {
    const outcomes = await collect(fakeAdp());
    const floors = noiseFloors(observationsOf(outcomes, study()), ['acceptance']);
    expect(floors).toHaveLength(1);
    expect(floors[0]!.sd).toBeGreaterThan(0);
    expect(floors[0]!.cells).toBe(2);
  });

  it('is reported before any contrast, and says so when it cannot be measured', () => {
    const html = renderHtml(
      buildReport({
        study: study(),
        outcomes: { studyDigest: 'd', collectedAt: 'now', trials: [], missing: [], exclusions: {} },
        noiseFloors: [],
        stats: {},
      }),
    );
    expect(html.indexOf('Noise floor')).toBeLessThan(html.indexOf('Statistics'));
    expect(html).toContain('Not measurable');
  });
});

// ─── The report ──────────────────────────────────────────────────────────

describe('report.json', () => {
  it('carries the pre-registration, digests and every trial verdict', async () => {
    const outcomes = await collect(fakeAdp());
    const report = buildReport({ study: study(), outcomes, noiseFloors: [], stats: {} });

    expect(report.preRegistration.current.primaryMetric).toBe('acceptance');
    expect(report.preRegistration.amended).toBe(false);
    expect(report.study.arms.map((a) => a.digest)).toHaveLength(2);
    expect(new Set(report.study.arms.map((a) => a.digest)).size).toBe(2);
    expect(report.trials.every((t) => t.verdict === 'ok')).toBe(true);
    expect(report.study.tasks[0]!.graderSha256).toBe(SHA);
  });

  it('says statistics are unavailable rather than showing a study that found nothing', async () => {
    const outcomes = await collect(fakeAdp());
    const html = renderHtml(
      buildReport({
        study: study(),
        outcomes,
        noiseFloors: [],
        stats: {},
        statsUnavailable: 'no interpreter',
      }),
    );
    expect(html).toContain('Not computed');
    expect(html).toContain('no interpreter');
  });
});

// ─── The statistics bridge ───────────────────────────────────────────────

describe('the statistics bridge', () => {
  const available = existsSync(pythonPath());

  it('refuses loudly when the interpreter is absent', async () => {
    const original = process.env.DUVA_BENCH_PYTHON;
    process.env.DUVA_BENCH_PYTHON = '/nonexistent/python';
    try {
      // A report that silently omitted its statistics would look like a study
      // that found nothing.
      await expect(pairedStats({ axis: 'acceptance', arms: {} })).rejects.toBeInstanceOf(
        StatsBridgeUnavailable,
      );
    } finally {
      if (original === undefined) delete process.env.DUVA_BENCH_PYTHON;
      else process.env.DUVA_BENCH_PYTHON = original;
    }
  });

  it.skipIf(!available)('gives identical output for identical input', async () => {
    const request = {
      axis: 'acceptance',
      baseline: 'standard',
      seed: 0,
      resamples: 2000,
      arms: {
        standard: { retry: [true, false], semver: [true, true] },
        twin: { retry: [false, false], semver: [true, false] },
      },
    };
    const [a, b] = await Promise.all([pairedStats(request), pairedStats(request)]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.skipIf(!available)('corrects for multiplicity across more than two arms', async () => {
    const result = await pairedStats({
      axis: 'acceptance',
      baseline: 'standard',
      seed: 0,
      resamples: 500,
      arms: {
        standard: { t1: [true, true], t2: [true, true] },
        b: { t1: [false, false], t2: [true, false] },
        c: { t1: [false, false], t2: [false, false] },
      },
    });
    expect(result.pairs).toHaveLength(2);
    for (const pair of result.pairs) {
      // Every extra contrast is another chance to find something.
      expect(pair.p_value_holm).toBeGreaterThanOrEqual(pair.p_value);
    }
  });
});
