/**
 * The grading path, against a real ADP.
 *
 * The unit tests answer the shapes; this answers whether the server agrees.
 * It exercises everything the M3 slice needs — two runs on one intent, two
 * axes each, reported by an identity that did not open them — and stops short
 * of invoking a model, so it costs nothing and can be run on every change.
 *
 * What it proves, in the exit criterion's own words: each run's `/evals` lists
 * both axes, every one of them `separately_authorized: true`, and all four
 * share a single `spec_digest`. Plus the guard: two tokens on one login refuse
 * to launch.
 *
 *   make up && npm run migrate --prefix server        # in an ADP checkout
 *   npx tsx src/bootstrap.ts squad-lab-runner         # → SQUAD_LAB_ADP_TOKEN
 *   npx tsx src/bootstrap.ts squad-lab-grader         # → SQUAD_LAB_EVAL_TOKEN
 *   SQUAD_LAB_ADP_TOKEN=… SQUAD_LAB_EVAL_TOKEN=… \
 *     npx tsx packages/squad-lab/scripts/live-grade-check.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGoal,
  ensureRepo,
  gitRemote,
  listEvals,
  compareRuns,
  whoami,
  type AdpEndpoint,
} from '../src/adp.js';
import { assertSeparateIdentities, gradeVariant, SameIdentityError } from '../src/grader.js';

const ADP_URL = process.env['ADP_URL'] ?? 'http://127.0.0.1:8793';
const OWNER = process.env['ADP_OWNER'] ?? 'lab';
const REPO = process.env['ADP_REPO'] ?? `gradecheck-${Date.now().toString(36)}`;

const runnerToken = required('SQUAD_LAB_ADP_TOKEN');
const evalToken = required('SQUAD_LAB_EVAL_TOKEN');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const runner: AdpEndpoint = { baseUrl: ADP_URL, token: runnerToken, owner: OWNER, repo: REPO };
const grader: AdpEndpoint = { ...runner, token: evalToken };

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

/** A two-axis grader, disagreeing across axes the way the real one did. */
const GRADER_SOURCE = `
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(process.argv[2]);
const present = existsSync(join(repo, 'duration.js'));
const selfTests = existsSync(join(repo, 'duration.test.js'));

console.log(JSON.stringify({
  spec: { suite: 'duration-acceptance', cases: 19, visibility: 'hidden from the agents' },
  axes: {
    acceptance: {
      score: present ? 1 : 0,
      passed: present,
      summary: present ? 'hidden suite: 19/19' : 'no module delivered',
      metrics: { passed: present ? 19 : 0, total: 19, module_present: present },
    },
    'self-tests': {
      score: selfTests ? 1 : 0,
      passed: selfTests,
      summary: selfTests ? "repo's own suite passed" : "repo shipped no tests",
      metrics: { present: selfTests },
    },
  },
}));
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * A work repo with a real commit pushed to ADP.
 *
 * The sha has to resolve *in ADP's* repository: closing a run against one that
 * only exists locally fails with "commit could not be resolved", and an eval
 * needs a closed run's sha as its subject.
 */
function seedWorkRepo(dir: string, withTests: boolean): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'lab@example.invalid');
  git(dir, 'config', 'user.name', 'squad-lab');
  writeFileSync(join(dir, 'duration.js'), 'module.exports = function parseDuration() { return null; };\n');
  if (withTests) writeFileSync(join(dir, 'duration.test.js'), '// the run wrote its own tests\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'deliver the module');
  git(dir, 'remote', 'add', 'origin', gitRemote(runner));
  git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/lab/${withTests ? 'b' : 'a'}`);
  return git(dir, 'rev-parse', 'HEAD');
}

async function adp<T>(ep: AdpEndpoint, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ep.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lab-live-'));
  const graderPath = join(root, 'grader.mjs');
  writeFileSync(graderPath, GRADER_SOURCE);
  const graderSha256 = execFileSync('sha256sum', [graderPath], { encoding: 'utf8' }).split(' ')[0]!;

  console.log(`ADP ${ADP_URL} · repo ${OWNER}/${REPO}`);
  const logins = await assertSeparateIdentities(runner, grader);
  check('the runner and grader tokens are two principals', true, logins);

  // The guard, from the other side: the same token twice has to be refused.
  await assertSeparateIdentities(runner, runner).then(
    () => check('two tokens on one login are refused', false, 'it was accepted'),
    (err) => check('two tokens on one login are refused', err instanceof SameIdentityError),
  );

  await ensureRepo(runner);
  const goal = await createGoal(runner, 'parse a duration', 'Export parseDuration(input).');
  console.log(`goal: issue #${goal.issueNumber}, intent ${goal.intentId}`);

  const graded: { variantId: string; runId: string }[] = [];
  for (const [variantId, model, withTests] of [
    ['anthropic', 'claude-sonnet-5', false],
    ['gemini', 'gemini-flash-latest', true],
  ] as const) {
    const workRepo = join(root, variantId, 'work');
    const sha = seedWorkRepo(workRepo, withTests);

    const run = await adp<{ id: string; labels?: Record<string, string> }>(
      runner,
      'POST',
      `/api/adp/repos/${OWNER}/${REPO}/runs`,
      {
        intent_id: goal.intentId,
        orchestrator: 'squad',
        external_ref: `live:${variantId}`,
        // The same labels `runVariant` sets, so this exercises the field the
        // summary ranks on rather than a stand-in for it.
        labels: { provider: variantId, model, variant: variantId },
      },
    );
    check(`${variantId}: labelled at open`, run.labels?.['provider'] === variantId, run.labels);
    await adp(runner, 'POST', `/api/adp/repos/${OWNER}/${REPO}/runs/${run.id}/close`, {
      final_git_sha: sha,
    });

    const grade = await gradeVariant({
      graderPath,
      graderSha256,
      primaryAxis: 'acceptance',
      workRepo,
      runId: run.id,
      outDir: join(root, variantId),
      gitSha: sha,
      evalEndpoint: grader,
    });
    check(`${variantId}: graded`, grade.outcome === 'scored', {
      digest: grade.specDigest?.slice(0, 12),
      warnings: grade.warnings ?? [],
    });
    graded.push({ variantId, runId: run.id });
  }

  // The exit criterion, read back off the server rather than off our own record.
  const digests = new Set<string>();
  for (const { variantId, runId } of graded) {
    const { evals } = await listEvals(runner, runId);
    const names = evals.map((e) => e['name']).sort();
    check(`${variantId}: both axes recorded`, names.length === 2, names);
    check(
      `${variantId}: every axis separately authorized`,
      evals.length > 0 && evals.every((e) => e['separately_authorized'] === true),
      evals.map((e) => [e['name'], e['separately_authorized']]),
    );
    for (const e of evals) digests.add(String(e['spec_digest']));
  }
  check('all four evals share one spec digest', digests.size === 1, [...digests].map((d) => d.slice(0, 12)));

  const { runs } = await compareRuns(runner, goal.intentId);
  check('the intent compares two runs', runs.length === 2, runs.map((r) => r.externalRef));
  // Both fields arrived in ADP 0.2.0. A row that carried only the single latest
  // `eval` would rank on whichever axis was posted last, which is a property of
  // the POST order and not of the work.
  check(
    'compare rows carry every axis',
    runs.every((r) => (r.evals?.length ?? 0) === 2),
    runs.map((r) => (r.evals ?? []).map((e) => e.name)),
  );
  check(
    'compare rows carry the provider label',
    runs.every((r) => Boolean(r.labels?.['provider'])),
    runs.map((r) => r.labels?.['provider'] ?? null),
  );

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
