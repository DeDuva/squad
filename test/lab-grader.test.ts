/**
 * Scoring, and the three ways it quietly stops being a measurement.
 *
 * A grade is only evidence if the rubric is identified (`spec_digest`), the
 * reporter is not the runner (`separately_authorized`), and a grader that fell
 * over leaves the variant *unscored* rather than scored zero. Each of those is
 * invisible in a summary table once it has gone wrong, so each is asserted
 * here rather than trusted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSeparateIdentities,
  canonicalJson,
  evalSpec,
  gradeVariant,
  parseGraderReport,
  reportGrade,
  runGrader,
  specDigestOf,
  GraderContractError,
  SameIdentityError,
} from '../packages/squad-lab/src/grader.js';
import type { AdpEndpoint } from '../packages/squad-lab/src/adp.js';

const GRADER_SHA = 'a'.repeat(64);

/** A grader that prints exactly what the contract asks for. */
const GOOD_GRADER = `
const repo = process.argv[2];
console.log(JSON.stringify({
  spec: { suite: 'duration-acceptance', cases: 19, visibility: 'hidden from the agents' },
  axes: {
    'self-tests': { score: 0, passed: false, summary: "repo's own suite failed", metrics: { exitCode: 1 } },
    acceptance: { score: 1, passed: true, summary: 'hidden suite: 19/19',
                  metrics: { passed: 19, total: 19, failures: 0, repo } },
  },
}));
`;

let root: string;
let graderPath: string;
let workRepo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lab-grader-'));
  graderPath = join(root, 'grader.mjs');
  workRepo = join(root, 'work');
  mkdirSync(workRepo, { recursive: true });
  writeFileSync(graderPath, GOOD_GRADER);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// --- the rubric's identity --------------------------------------------------

describe('spec digest', () => {
  it('does not depend on the order the grader built its spec in', () => {
    const a = specDigestOf({ suite: 'x', cases: 19, nested: { b: 1, a: 2 } });
    const b = specDigestOf({ nested: { a: 2, b: 1 }, cases: 19, suite: 'x' });
    expect(a).toBe(b);
  });

  it('keeps array order, because in an array order is content', () => {
    expect(canonicalJson({ cases: ['a', 'b'] })).not.toBe(canonicalJson({ cases: ['b', 'a'] }));
  });

  it('changes when the grader file changes, even for an identical spec', () => {
    const spec = { suite: 'duration-acceptance', cases: 19 };
    const before = specDigestOf(evalSpec(spec, 'a'.repeat(64)));
    const after = specDigestOf(evalSpec(spec, 'b'.repeat(64)));
    // This is the whole reason the lab injects the digest: without it, editing
    // the grader between variant one and variant three ranks two runs scored
    // under two different rubrics and says nothing about it.
    expect(before).not.toBe(after);
  });

  it("overrides a grader that tries to name its own file's digest", () => {
    const spec = evalSpec({ suite: 'x', graderSha256: 'lies' }, GRADER_SHA);
    expect(spec['graderSha256']).toBe(GRADER_SHA);
  });

  it('agrees with the digest ADP derives from the same spec', () => {
    // ADP's `core/evals.ts` hashes `canonicalJson(spec)` with sha256. The lab
    // computes what it expects so a disagreement is reported rather than
    // silently accepted as the digest of record.
    const spec = evalSpec({ suite: 'x', cases: 19 }, GRADER_SHA);
    const adpSide = createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex');
    expect(specDigestOf(spec)).toBe(adpSide);
  });
});

// --- the contract -----------------------------------------------------------

describe('parseGraderReport', () => {
  it('reads axes, keeping a null score as null', () => {
    const report = parseGraderReport(
      JSON.stringify({ spec: { suite: 'x' }, axes: { a: { score: null, passed: false } } }),
    );
    expect(report.axes['a']?.score).toBeNull();
  });

  it.each([
    ['empty output', ''],
    ['not JSON', 'Traceback (most recent call last)'],
    ['a bare array', '[]'],
    ['no spec', JSON.stringify({ axes: { a: { score: 1, passed: true } } })],
    ['no axes', JSON.stringify({ spec: {} })],
    ['zero axes', JSON.stringify({ spec: {}, axes: {} })],
    ['a non-boolean passed', JSON.stringify({ spec: {}, axes: { a: { score: 1, passed: 'yes' } } })],
    ['a score above 1', JSON.stringify({ spec: {}, axes: { a: { score: 1.5, passed: true } } })],
    ['a score below 0', JSON.stringify({ spec: {}, axes: { a: { score: -1, passed: true } } })],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseGraderReport(stdout)).toThrow(GraderContractError);
  });
});

// --- invocation -------------------------------------------------------------

describe('runGrader', () => {
  it('runs the grader against the work repo and parses its report', async () => {
    const run = await runGrader({ graderPath, workRepo });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(Object.keys(run.report.axes).sort()).toEqual(['acceptance', 'self-tests']);
    expect(run.report.axes['acceptance']?.score).toBe(1);
  });

  it('leaves the variant unscored — not zero — when the grader exits non-zero', async () => {
    writeFileSync(graderPath, 'process.exit(3);');
    const run = await runGrader({ graderPath, workRepo });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.exitCode).toBe(3);
    expect(run.reason).toMatch(/non-zero/);
  });

  it('leaves the variant unscored when the grader prints something unparsable', async () => {
    writeFileSync(graderPath, 'console.log("almost json");');
    const run = await runGrader({ graderPath, workRepo });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toMatch(/not JSON/);
  });

  it('refuses to run inside the work repo, which is what keeps the suite hidden', async () => {
    await expect(runGrader({ graderPath, workRepo, cwd: join(workRepo, 'sub') })).rejects.toThrow(
      /inside the work repo/,
    );
    await expect(runGrader({ graderPath, workRepo, cwd: workRepo })).rejects.toThrow(
      /inside the work repo/,
    );
  });

  it('hands the grader no ADP token — it measures, it does not report', async () => {
    writeFileSync(
      graderPath,
      `console.log(JSON.stringify({ spec: {}, axes: { env: { score: null, passed: true,
         metrics: { seen: Object.keys(process.env).filter((k) => k.includes('TOKEN')) } } } }));`,
    );
    process.env['SQUAD_LAB_EVAL_TOKEN'] = 'secret-grader-token';
    try {
      const run = await runGrader({ graderPath, workRepo });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.report.axes['env']?.metrics?.['seen']).toEqual([]);
    } finally {
      delete process.env['SQUAD_LAB_EVAL_TOKEN'];
    }
  });
});

// --- reporting --------------------------------------------------------------

interface PostedEval {
  path: string;
  body: Record<string, unknown>;
}

/** An ADP that records what it was told and answers the way the real one does. */
function fakeAdp(
  overrides: (body: Record<string, unknown>, digest: string) => Record<string, unknown> = () => ({}),
): { ep: AdpEndpoint; posts: PostedEval[] } {
  const posts: PostedEval[] = [];
  const ep: AdpEndpoint = {
    baseUrl: 'http://adp.test',
    token: 'eval-token',
    owner: 'lab',
    repo: 'bake',
    fetchImpl: (async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      posts.push({ path: new URL(url).pathname, body });
      const digest = specDigestOf(body['spec']);
      const extra = overrides(body, digest);
      if (extra['__status']) {
        return new Response(JSON.stringify({ message: extra['__message'] }), {
          status: extra['__status'] as number,
        });
      }
      return new Response(
        JSON.stringify({
          id: `eval_${posts.length}`,
          name: body['name'],
          score: body['score'] ?? null,
          spec_digest: digest,
          separately_authorized: true,
          ...extra,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch,
  };
  return { ep, posts };
}

const twoAxes = {
  spec: { suite: 'duration-acceptance', cases: 19 },
  axes: {
    acceptance: { score: 1, passed: true, summary: '19/19', metrics: { passed: 19 } },
    'self-tests': { score: null, passed: false, summary: 'did not apply' },
  },
};

describe('reportGrade', () => {
  it('posts one eval per axis, all under one spec digest', async () => {
    const { ep, posts } = fakeAdp();
    const result = await reportGrade(ep, 'run_1', {
      report: twoAxes,
      graderSha256: GRADER_SHA,
      primaryAxis: 'acceptance',
    });

    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.body['name'])).toEqual(['acceptance', 'self-tests']);
    expect(posts.every((p) => p.path === '/api/adp/repos/lab/bake/runs/run_1/evals')).toBe(true);
    // One rubric per experiment: two axes scored under different digests are
    // two measurements, not a comparison.
    expect(new Set(result.axes.map((a) => a.specDigest)).size).toBe(1);
    expect(result.axes[0]?.specDigest).toBe(result.specDigest);
    expect(result.warnings).toEqual([]);
  });

  it('carries the lab-injected grader digest into every axis spec', async () => {
    const { ep, posts } = fakeAdp();
    await reportGrade(ep, 'run_1', { report: twoAxes, graderSha256: GRADER_SHA });
    for (const post of posts) {
      expect((post.body['spec'] as Record<string, unknown>)['graderSha256']).toBe(GRADER_SHA);
    }
  });

  it('reports exactly one axis under the gate name `score`', async () => {
    const { ep, posts } = fakeAdp();
    await reportGrade(ep, 'run_1', {
      report: twoAxes,
      graderSha256: GRADER_SHA,
      primaryAxis: 'acceptance',
    });
    // Two axes under one gate name would make latest-wins resolution depend on
    // which POST landed second, so `best_score` would rank on a coin flip.
    const gated = posts.filter((p) => p.body['gate_name'] === 'score');
    expect(gated).toHaveLength(1);
    expect(gated[0]?.body['name']).toBe('acceptance');
  });

  it('omits the score for an axis that did not apply rather than sending zero', async () => {
    const { ep, posts } = fakeAdp();
    const result = await reportGrade(ep, 'run_1', { report: twoAxes, graderSha256: GRADER_SHA });
    const unapplied = posts.find((p) => p.body['name'] === 'self-tests')!;
    expect('score' in unapplied.body).toBe(false);
    expect(result.axes.find((a) => a.axis === 'self-tests')?.score).toBeNull();
  });

  it('warns when a configured primary axis is not one the grader reported', async () => {
    const { ep, posts } = fakeAdp();
    const result = await reportGrade(ep, 'run_1', {
      report: twoAxes,
      graderSha256: GRADER_SHA,
      primaryAxis: 'coverage',
    });
    expect(result.warnings.join(' ')).toMatch(/primary axis 'coverage'/);
    expect(posts.some((p) => p.body['gate_name'] === 'score')).toBe(false);
  });

  it('says so when ADP stores a digest the lab did not compute', async () => {
    const { ep } = fakeAdp(() => ({ spec_digest: 'f'.repeat(64) }));
    const result = await reportGrade(ep, 'run_1', { report: twoAxes, graderSha256: GRADER_SHA });
    expect(result.warnings.join(' ')).toMatch(/not canonicalizing the same spec/);
  });

  it('says so when ADP reports the score as a self-report', async () => {
    const { ep } = fakeAdp(() => ({ separately_authorized: false }));
    const result = await reportGrade(ep, 'run_1', { report: twoAxes, graderSha256: GRADER_SHA });
    expect(result.warnings.join(' ')).toMatch(/self-report/);
  });

  it('records an axis ADP rejected without losing the axes it accepted', async () => {
    // A run that never pushed has no final sha, and ADP 422s rather than
    // scoring nothing in particular.
    const { ep } = fakeAdp((body) =>
      body['name'] === 'acceptance'
        ? { __status: 422, __message: 'run has no final_git_sha' }
        : {},
    );
    const result = await reportGrade(ep, 'run_1', { report: twoAxes, graderSha256: GRADER_SHA });
    const acceptance = result.axes.find((a) => a.axis === 'acceptance')!;
    expect(acceptance.posted).toBe(false);
    expect(acceptance.error).toMatch(/final_git_sha/);
    expect(result.axes.find((a) => a.axis === 'self-tests')?.posted).toBe(true);
  });
});

// --- the two identities -----------------------------------------------------

describe('assertSeparateIdentities', () => {
  const withLogin = (login: string): AdpEndpoint => ({
    baseUrl: 'http://adp.test',
    token: `tok-${login}`,
    owner: 'lab',
    repo: 'bake',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ login }), { status: 200 })) as unknown as typeof fetch,
  });

  it('refuses two tokens that resolve to one login', async () => {
    // `separately_authorized` compares identities, not tokens, so this
    // misconfiguration produces evals that look like evidence and are not.
    await expect(
      assertSeparateIdentities(withLogin('squad-lab-runner'), withLogin('squad-lab-runner')),
    ).rejects.toThrow(SameIdentityError);
  });

  it('passes two distinct logins through', async () => {
    await expect(
      assertSeparateIdentities(withLogin('squad-lab-runner'), withLogin('squad-lab-grader')),
    ).resolves.toEqual({ runner: 'squad-lab-runner', grader: 'squad-lab-grader' });
  });
});

// --- end to end -------------------------------------------------------------

describe('gradeVariant', () => {
  it('writes grade.json and posts every axis', async () => {
    const { ep, posts } = fakeAdp();
    const grade = await gradeVariant({
      graderPath,
      graderSha256: GRADER_SHA,
      primaryAxis: 'acceptance',
      workRepo,
      runId: 'run_1',
      outDir: root,
      evalEndpoint: ep,
    });

    expect(grade.outcome).toBe('scored');
    expect(posts).toHaveLength(2);
    const onDisk = JSON.parse(readFileSync(join(root, 'grade.json'), 'utf8'));
    // The grader's raw report is kept verbatim: a score with no path back to
    // the metrics that produced it is a claim.
    expect(onDisk.report.axes.acceptance.metrics.total).toBe(19);
    expect(onDisk.specDigest).toBe(grade.specDigest);
  });

  it('records why a variant is unscored instead of leaving a blank cell', async () => {
    writeFileSync(graderPath, 'process.exit(1);');
    const { ep, posts } = fakeAdp();
    const grade = await gradeVariant({
      graderPath,
      graderSha256: GRADER_SHA,
      workRepo,
      runId: 'run_1',
      outDir: root,
      evalEndpoint: ep,
    });

    expect(grade.outcome).toBe('unscored');
    expect(grade.reason).toMatch(/non-zero/);
    expect(posts).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, 'grade.json'), 'utf8')).reason).toMatch(/non-zero/);
  });

  it('still grades a variant that produced no run, and says it could not report it', async () => {
    const grade = await gradeVariant({
      graderPath,
      graderSha256: GRADER_SHA,
      workRepo,
      runId: null,
      outDir: root,
    });
    expect(grade.outcome).toBe('unscored');
    expect(grade.reason).toMatch(/no run to score/);
    // The measurement itself survives even though nothing could receive it.
    expect(grade.report?.axes['acceptance']?.score).toBe(1);
  });
});
