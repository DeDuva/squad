/**
 * The exec summary's judgement calls.
 *
 * The numbers are ADP's and are passed through untouched, so what is worth
 * pinning here is the part the lab decides: that axes are ranked separately,
 * that unmeasured never reads as zero, and that the conditions which make a
 * comparison invalid are stated rather than smoothed over.
 */

import { describe, it, expect } from 'vitest';
import { buildSummary, rankByAxis, UNPRICED_PROVIDERS } from '../packages/squad-lab/src/summary.js';
import type { Experiment } from '../packages/squad-lab/src/experiments.js';
import type { AdpEndpoint } from '../packages/squad-lab/src/adp.js';

const DIGEST = 'a1bc415171e9';

function experiment(): Experiment {
  return {
    id: 'exp_1',
    createdAt: '2026-08-05T00:00:00.000Z',
    status: 'complete',
    goal: { title: 'Add a duration parser', body: '' },
    adp: { url: 'http://adp.test', owner: 'lab', repo: 'duration', issueNumber: 1, intentId: 'intent-1', tokenEnv: 'T' },
    seed: { repoUrl: '/seed' },
    grader: { path: '/grader.mjs', sha256: 'deadbeef', primaryAxis: 'acceptance' },
    agents: [],
    routing: [],
    registeredTools: ['write_file', 'read_file', 'run_node_test'],
    variants: [
      { id: 'anthropic', provider: 'anthropic', externalRef: 'exp_1:anthropic' },
      { id: 'gemini', provider: 'gemini', externalRef: 'exp_1:gemini' },
    ],
  };
}

function row(externalRef: string, evals: { name: string; score: number | null; digest?: string }[], extra: Record<string, unknown> = {}) {
  return {
    runId: `run-${externalRef}`,
    externalRef,
    orchestrator: 'squad',
    status: 'closed',
    finalGitSha: 'a'.repeat(40),
    trajectoryDigest: 'd',
    eval: null,
    evals: evals.map((e) => ({
      name: e.name,
      score: e.score,
      passed: (e.score ?? 0) > 0,
      specDigest: e.digest ?? DIGEST,
      gateStatus: 'success',
    })),
    events: 18,
    tokensIn: 100,
    tokensOut: 10,
    costMicroUsd: 0,
    durationMs: 1000,
    toolCalls: 7,
    toolFailures: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    closedAt: '2026-08-05T00:01:00.000Z',
    ...extra,
  };
}

/** A fetch that answers only `/runs/compare`, with the rows given. */
function fakeAdp(rows: unknown[]): AdpEndpoint {
  return {
    baseUrl: 'http://adp.test',
    token: 't',
    owner: 'lab',
    repo: 'duration',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ intent_id: 'intent-1', runs: rows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
  };
}

describe('buildSummary', () => {
  it('maps runs back to the variant that produced them, by external ref', async () => {
    const s = await buildSummary(
      experiment(),
      fakeAdp([row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])]),
    );
    expect(s.rows.map((r) => r.variantId).sort()).toEqual(['anthropic', 'gemini']);
    expect(s.rows.find((r) => r.variantId === 'gemini')!.provider).toBe('gemini');
  });

  it('collects every axis anyone reported, so a gap is visible', async () => {
    const s = await buildSummary(
      experiment(),
      fakeAdp([
        row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }, { name: 'self-tests', score: 0 }]),
        row('exp_1:gemini', [{ name: 'acceptance', score: 1 }]),
      ]),
    );
    expect(s.axes).toEqual(['acceptance', 'self-tests']);
    expect(s.warnings).toContainEqual({ kind: 'missing_axis', axis: 'self-tests', variantId: 'gemini' });
  });

  it('flags an axis scored under two different rubrics', async () => {
    // The failure a blended score hides best: two numbers that were never
    // measuring the same thing, presented as a ranking.
    const s = await buildSummary(
      experiment(),
      fakeAdp([
        row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]),
        row('exp_1:gemini', [{ name: 'acceptance', score: 1, digest: 'different' }]),
      ]),
    );
    expect(s.warnings).toContainEqual({
      kind: 'spec_digest_mismatch',
      axis: 'acceptance',
      variantId: 'gemini',
      got: 'different',
      expected: DIGEST,
    });
  });

  it('flags a variant that produced no run at all', async () => {
    const s = await buildSummary(experiment(), fakeAdp([row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }])]));
    expect(s.warnings).toContainEqual({ kind: 'run_missing', variantId: 'gemini' });
  });

  it('flags an unscored run rather than treating it as a zero', async () => {
    const s = await buildSummary(
      experiment(),
      fakeAdp([row('exp_1:anthropic', []), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])]),
    );
    expect(s.warnings).toContainEqual({ kind: 'unscored', variantId: 'anthropic' });
  });

  it('says so when the set spans a priced and an unpriced vendor', async () => {
    // Gemini's version-free aliases are deliberately unpriced, so its cost is
    // structurally zero. Comparing that against a real figure is not a cost
    // comparison, and the summary has to say it out loud.
    expect(UNPRICED_PROVIDERS.has('gemini')).toBe(true);
    const s = await buildSummary(
      experiment(),
      fakeAdp([row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])]),
    );
    expect(s.warnings).toContainEqual({ kind: 'cost_incomparable', providers: ['gemini'] });
  });

  it('does not flag cost when every vendor in the set is unpriced', async () => {
    const exp = experiment();
    exp.variants = [
      { id: 'g1', provider: 'gemini', externalRef: 'exp_1:g1' },
      { id: 'g2', provider: 'gemini', externalRef: 'exp_1:g2' },
    ];
    const s = await buildSummary(
      exp,
      fakeAdp([row('exp_1:g1', [{ name: 'acceptance', score: 1 }]), row('exp_1:g2', [{ name: 'acceptance', score: 1 }])]),
    );
    expect(s.warnings.filter((w) => w.kind === 'cost_incomparable')).toHaveLength(0);
  });

  it('falls back to run labels when the external ref is not one of ours', async () => {
    const s = await buildSummary(
      experiment(),
      fakeAdp([row('someone-elses-ref', [{ name: 'acceptance', score: 1 }], { labels: { variant: 'v9', provider: 'gemini' } })]),
    );
    expect(s.rows[0]!.variantId).toBe('v9');
    expect(s.rows[0]!.provider).toBe('gemini');
  });
});

describe('rankByAxis', () => {
  const summaryWith = (rows: any[]) => ({
    experimentId: 'exp_1',
    intentId: 'intent-1',
    axes: ['acceptance', 'self-tests'],
    rows,
    warnings: [],
  });

  it('ranks each axis independently, so a win on one says nothing about the other', () => {
    // The m8 finding, as a test: both vendors tie on the module and split on
    // whether the delivered repo actually runs.
    const s = summaryWith([
      { ...row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }, { name: 'self-tests', score: 0 }]), variantId: 'anthropic' },
      { ...row('exp_1:gemini', [{ name: 'acceptance', score: 1 }, { name: 'self-tests', score: 1 }]), variantId: 'gemini' },
    ]);

    const acceptance = rankByAxis(s as any, 'acceptance');
    expect(acceptance.every((e) => e.rank === 1)).toBe(true);

    const selfTests = rankByAxis(s as any, 'self-tests');
    expect(selfTests.find((e) => e.variantId === 'gemini')!.rank).toBe(1);
    expect(selfTests.find((e) => e.variantId === 'anthropic')!.rank).toBe(2);
  });

  it('leaves an unmeasured variant unranked rather than last-by-score', () => {
    const s = summaryWith([
      { ...row('exp_1:anthropic', [{ name: 'acceptance', score: 0.5 }]), variantId: 'anthropic' },
      { ...row('exp_1:gemini', []), variantId: 'gemini' },
    ]);
    const ranked = rankByAxis(s as any, 'acceptance');
    const gemini = ranked.find((e) => e.variantId === 'gemini')!;
    expect(gemini.score).toBeNull();
    expect(gemini.rank).toBeNull();
    expect(ranked.find((e) => e.variantId === 'anthropic')!.rank).toBe(1);
  });

  it('gives tied scores the same rank', () => {
    const s = summaryWith([
      { ...row('exp_1:a', [{ name: 'acceptance', score: 1 }]), variantId: 'a' },
      { ...row('exp_1:b', [{ name: 'acceptance', score: 1 }]), variantId: 'b' },
      { ...row('exp_1:c', [{ name: 'acceptance', score: 0.5 }]), variantId: 'c' },
    ]);
    const ranked = rankByAxis(s as any, 'acceptance');
    expect(ranked.find((e) => e.variantId === 'a')!.rank).toBe(1);
    expect(ranked.find((e) => e.variantId === 'b')!.rank).toBe(1);
    expect(ranked.find((e) => e.variantId === 'c')!.rank).toBe(3);
  });
});

describe('buildSummary tool taxonomy', () => {
  /** Answers `/runs/compare` and `/runs/{id}/stats` differently. */
  function adpWithStats(rows: any[], statsByRun: Record<string, unknown>): AdpEndpoint {
    return {
      baseUrl: 'http://adp.test',
      token: 't',
      owner: 'lab',
      repo: 'duration',
      fetchImpl: (async (input: any) => {
        const url = String(input);
        const hit = Object.keys(statsByRun).find((id) => url.includes(`/runs/${id}/stats`));
        const body = hit
          ? statsByRun[hit]
          : { intent_id: 'intent-1', runs: rows };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    };
  }

  it('splits registered from backend-supplied tools per run', async () => {
    const rows = [row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])];
    const s = await buildSummary(
      experiment(),
      adpWithStats(rows, {
        'run-exp_1:anthropic': {
          tools: [
            { name: 'Bash', count: 3, failures: 0 },
            { name: 'mcp__squad__write_file', count: 1, failures: 0 },
          ],
        },
        'run-exp_1:gemini': { tools: [{ name: 'write_file', count: 4, failures: 0 }] },
      }),
    );

    const a = s.rows.find((r) => r.variantId === 'anthropic')!;
    const g = s.rows.find((r) => r.variantId === 'gemini')!;
    expect(a.tools!.registeredCalls).toBe(1);
    expect(a.tools!.builtinCalls).toBe(3);
    expect(g.tools!.registeredCalls).toBe(4);
    expect(g.tools!.hasBuiltins).toBe(false);
  });

  it('warns when only some variants had backend tools, which is when totals stop matching', async () => {
    const rows = [row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])];
    const s = await buildSummary(
      experiment(),
      adpWithStats(rows, {
        'run-exp_1:anthropic': { tools: [{ name: 'Bash', count: 3, failures: 0 }] },
        'run-exp_1:gemini': { tools: [{ name: 'write_file', count: 4, failures: 0 }] },
      }),
    );
    expect(s.warnings).toContainEqual({ kind: 'tools_not_like_for_like', variantIds: ['anthropic'] });
  });

  it('does not warn when no variant had backend tools', async () => {
    const rows = [row('exp_1:anthropic', [{ name: 'acceptance', score: 1 }]), row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])];
    const s = await buildSummary(
      experiment(),
      adpWithStats(rows, {
        'run-exp_1:anthropic': { tools: [{ name: 'write_file', count: 2, failures: 0 }] },
        'run-exp_1:gemini': { tools: [{ name: 'write_file', count: 4, failures: 0 }] },
      }),
    );
    expect(s.warnings.filter((w) => w.kind === 'tools_not_like_for_like')).toHaveLength(0);
  });

  it('still produces a summary when stats are unavailable', async () => {
    // Stats are an enrichment; a summary that vanishes because one extra
    // request failed is worse than one without the split.
    const ep: AdpEndpoint = {
      baseUrl: 'http://adp.test',
      token: 't',
      owner: 'lab',
      repo: 'duration',
      fetchImpl: (async (input: any) => {
        if (String(input).includes('/stats')) return new Response('nope', { status: 500 });
        return new Response(JSON.stringify({ intent_id: 'intent-1', runs: [row('exp_1:gemini', [{ name: 'acceptance', score: 1 }])] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    };
    const s = await buildSummary(experiment(), ep);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.tools).toBeUndefined();
  });
});
