/**
 * The factorial scheduler: every cell of a study, once, and exactly once.
 *
 * squad-lab's `scripts/study.ts` is the ancestor. It fans a task across
 * variants and works, and it has three properties a study of any size cannot
 * live without: it cannot be resumed, it cannot be stopped by a budget, and the
 * only record it leaves is a manifest written before the runs happen. A study
 * that dies at trial 140 of 160 has to start again — which in practice means it
 * is never rerun, and a result nobody can reproduce is not a result.
 *
 * So the three things this adds are all about surviving:
 *
 * **Resumption is by ADP, not by local state.** A rerun asks ADP which
 * `external_ref`s already carry a closed, verified run and skips those. Local
 * progress files are for humans; the run record is the truth. That means a
 * study resumes correctly even from a machine that has never seen it, and — the
 * property that actually matters — a crash cannot cause a duplicate run,
 * because `external_ref` is the recorder's idempotency key and re-opening it
 * rejoins rather than forks.
 *
 * **The budget stops the next trial, never the current one.** Checked before
 * launch, because there is no way to un-spend a turn and killing one mid-flight
 * would leave an open run for no saving. An unpriced model is reported as
 * unpriced and never as `$0.00`, so a cap can never be "satisfied" by a price
 * table that simply did not know the model.
 *
 * **`progress.jsonl` is append-only.** Every decision — planned, skipped,
 * started, finished, budget-stopped — is a line. A file that was rewritten in
 * place would lose exactly the history you want after a crash.
 *
 * One child process per trial, for the four reasons squad-lab documented and
 * this inherits: API keys and the credential chain are per-process; cwd is
 * per-process; a hung backend needs a real SIGKILL because `abort()` is only
 * cooperative; and a trial that dies must not take its siblings with it.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { priceUsage, type PriceTable } from '@deduvafork/squad-lab/pricing';
import {
  compareRuns,
  createGoal,
  ensureRepo,
  findGoalByTitle,
  gitRemote,
  verifyRun,
  type AdpEndpoint,
} from '@deduvafork/squad-lab/adp';

import { armDigest, shortDigest, studyDigest, type Arm, type Study, type TaskRef } from './study.js';
import type { TrialResult } from './runner.js';

// ─── Planning ────────────────────────────────────────────────────────────

export interface PlannedTrial {
  externalRef: string;
  taskId: string;
  armId: string;
  rep: number;
  studyDigest: string;
  armDigest: string;
}

/**
 * The intent title for a task, and the reason it is not the goal's own title.
 *
 * Two studies can legitimately use the same task, and their trials must not
 * share an intent — the digest in the title is what keeps them apart. A happy
 * accident of the convention: a title starting `duva:` cannot match any of the
 * coordinator's built-in direct-response patterns, all of which anchor at the
 * start of the string. The trap S1 removed cannot re-enter through the brief.
 */
export function intentTitle(digest: string, taskId: string): string {
  return `duva:${shortDigest(digest)}:${taskId}`;
}

/**
 * Every trial of a study, in a stable order.
 *
 * Task-major, then arm, then repetition — so an interrupted study resumes with
 * its remaining work grouped the same way, and a partial study is a prefix of
 * the full one rather than a random sample of it.
 */
export function planTrials(study: Study): PlannedTrial[] {
  const digest = studyDigest(study);
  const short = shortDigest(digest);
  const trials: PlannedTrial[] = [];

  for (const task of [...study.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const arm of [...study.arms].sort((a, b) => a.id.localeCompare(b.id))) {
      for (let rep = 1; rep <= study.preRegistration.repetitions; rep += 1) {
        trials.push({
          externalRef: `${short}:${arm.id}:${task.id}:r${rep}`,
          taskId: task.id,
          armId: arm.id,
          rep,
          studyDigest: digest,
          armDigest: armDigest(arm),
        });
      }
    }
  }

  return trials;
}

// ─── Intents ─────────────────────────────────────────────────────────────

export interface TaskIntent {
  taskId: string;
  issueNumber: number;
  intentId: string;
  /** True when this run of the scheduler filed it rather than finding it. */
  created: boolean;
}

/**
 * One intent per task, idempotently.
 *
 * Looks before it files. A resumed study that re-filed its goals would mint a
 * second intent per task and split every cell in half — the runs would still be
 * recorded, and `runs/compare` would simply never show them together again.
 */
export async function ensureTaskIntent(
  ep: AdpEndpoint,
  digest: string,
  task: TaskRef,
  goalBody: string,
): Promise<TaskIntent> {
  const title = intentTitle(digest, task.id);
  const existing = await findGoalByTitle(ep, title);
  if (existing) {
    return { taskId: task.id, issueNumber: existing.issueNumber, intentId: existing.intentId, created: false };
  }
  const goal = await createGoal(ep, title, goalBody);
  return { taskId: task.id, issueNumber: goal.issueNumber, intentId: goal.intentId, created: true };
}

// ─── Resumption ──────────────────────────────────────────────────────────

/**
 * Which `external_ref`s already hold a run worth keeping.
 *
 * "Closed" is not enough. A run can close and still fail `/verify` — a broken
 * hash chain, an unverified envelope — and skipping such a trial on resume
 * would bake an unusable run into the study permanently, since nothing would
 * ever run that cell again. So the check is closed *and* verified, and anything
 * else is replanned.
 *
 * Verified is not enough either, and the pilot study is what proved it. Grading
 * happens *after* the run closes, so a trial can close, verify, and then die
 * before it is scored. Resumption saw a closed verified run, called the cell
 * done, and left it permanently unscored — 18 of 24 trials in the first pilot
 * had no eval and no way to ever get one. When the study grades, a run without
 * an eval is not a completed trial.
 */
export async function completedRefs(
  ep: AdpEndpoint,
  intentIds: string[],
  deps: { compareRuns: typeof compareRuns; verifyRun: typeof verifyRun } = { compareRuns, verifyRun },
  options: { requireEval?: boolean } = {},
): Promise<Set<string>> {
  const done = new Set<string>();

  for (const intentId of intentIds) {
    const { runs } = await deps.compareRuns(ep, intentId);
    for (const run of runs) {
      if (run.status !== 'closed' || !run.externalRef) continue;
      if (options.requireEval) {
        const evals = run.evals ?? (run.eval ? [run.eval] : []);
        if (evals.length === 0) continue;
      }
      try {
        const verdict = await deps.verifyRun(ep, run.runId);
        if (verdict.ok === true) done.add(run.externalRef);
      } catch {
        // Unreachable `/verify` means "cannot confirm", and an unconfirmed run
        // is replanned rather than assumed good. Re-running a trial costs a few
        // cents; keeping an unverifiable one costs the study its evidence.
      }
    }
  }

  return done;
}

// ─── Budget ──────────────────────────────────────────────────────────────

export interface Spend {
  /** Known spend, in USD. */
  usd: number;
  /** Trials whose model the price table did not know. */
  unpriced: number;
}

/**
 * Price one finished trial.
 *
 * `reportedUsd` wins when a vendor gave one; otherwise the table. A model the
 * table does not know returns `null`, which is counted as unpriced rather than
 * folded in as zero — the rule the whole project runs on, because a cap
 * satisfied by ignorance is not a cap.
 */
export function priceTrial(result: TrialResult, table?: PriceTable): { usd: number | null } {
  const cost = result.cost as {
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalEstimatedCost?: number;
  };
  const priced = priceUsage(
    result.model,
    { inputTokens: cost.totalInputTokens ?? 0, outputTokens: cost.totalOutputTokens ?? 0 },
    {
      ...(table ? { table } : {}),
      ...(typeof cost.totalEstimatedCost === 'number' ? { reportedUsd: cost.totalEstimatedCost } : {}),
    },
  );
  return { usd: priced.costUsd };
}

// ─── Progress ────────────────────────────────────────────────────────────

export type ProgressEvent =
  | { at: string; kind: 'study'; digest: string; trials: number; budgetUsd: number }
  | { at: string; kind: 'intent'; taskId: string; intentId: string; created: boolean }
  | { at: string; kind: 'skipped'; externalRef: string; reason: 'already-verified' }
  | { at: string; kind: 'started'; externalRef: string }
  | {
      at: string;
      kind: 'finished';
      externalRef: string;
      outcome: string;
      verified: boolean | null;
      runId?: string;
      usd: number | null;
    }
  | { at: string; kind: 'failed'; externalRef: string; error: string }
  | { at: string; kind: 'budget-stop'; spentUsd: number; budgetUsd: number; remaining: number; unpriced: number };

/** Append-only, because the history after a crash is the point. */
export function appendProgress(path: string, event: ProgressEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

// ─── Running ─────────────────────────────────────────────────────────────

/** What the parent and the forked child say to each other. */
export type TrialChildMessage =
  | { t: 'result'; result: TrialResult }
  | { t: 'error'; message: string };

const childEntry = (): string => join(dirname(fileURLToPath(import.meta.url)), 'trial-child.js');

export interface TrialLaunch {
  trial: PlannedTrial;
  /** Everything the child needs, serialized across the fork. */
  argv: string[];
  /** Env additions — the ADP token, named but never written to disk. */
  env: NodeJS.ProcessEnv;
  outDir: string;
}

export interface RunStudyOptions {
  study: Study;
  /**
   * The spec file the study was read from.
   *
   * Passed to each child so it resolves the study's *relative* paths against
   * the spec's own directory. Handing the child a resolved copy written into
   * the run root instead resolves them against the root — which is silently
   * correct for a spec written with absolute paths and silently wrong for one
   * written the portable way. The first study with relative paths found this.
   */
  specPath?: string;
  ep: AdpEndpoint & { tokenEnv: string };
  /** Where progress, per-trial output and the manifest are written. */
  root: string;
  /** Resolve a task's goal text and seed repository. */
  resolveTask: (task: TaskRef) => { title: string; body: string; seed: string };
  priceTable?: PriceTable;
  /** Overridable so tests can drive the scheduler without forking. */
  deps?: Partial<SchedulerDeps>;
  onEvent?: (event: ProgressEvent) => void;
}

export interface SchedulerDeps {
  ensureRepo: typeof ensureRepo;
  ensureTaskIntent: typeof ensureTaskIntent;
  completedRefs: typeof completedRefs;
  runTrialProcess: (launch: TrialLaunch) => Promise<TrialResult>;
}

/**
 * One band of comparable trials.
 *
 * Trials are only rankable against each other when they ran the same program.
 * A single-agent arm and a swarm arm are not the same program however identical
 * their model, so they land in different bands and a report shows two tables
 * rather than one ordering — the rule that stops a topology difference being
 * reported as a model difference.
 */
export interface Band {
  harness: string;
  topology: string;
  armIds: string[];
  trials: number;
}

/**
 * Group results into comparable bands.
 *
 * Keyed on the two things that decide whether the agent ran the same program:
 * which loop drove it and how many agents there were. Anything that varies
 * *within* a band — model, toolset, docs grade — is the experiment; anything
 * that varies across bands is not a contrast, it is two experiments.
 */
export function bandResults(results: TrialResult[]): Band[] {
  const bands = new Map<string, Band>();
  for (const result of results) {
    const key = `${result.harness}\u0000${result.topology}`;
    const band = bands.get(key) ?? { harness: result.harness, topology: result.topology, armIds: [], trials: 0 };
    if (!band.armIds.includes(result.armId)) band.armIds.push(result.armId);
    band.trials += 1;
    bands.set(key, band);
  }
  return [...bands.values()].sort((a, b) =>
    `${a.harness}${a.topology}`.localeCompare(`${b.harness}${b.topology}`),
  );
}

export interface StudyReport {
  studyDigest: string;
  planned: number;
  skipped: number;
  ran: number;
  failed: number;
  spend: Spend;
  budgetStopped: boolean;
  results: TrialResult[];
  /** Comparable groups. More than one means the study must not be ranked as a whole. */
  bands: Band[];
}

/**
 * Run every remaining trial of a study.
 *
 * Concurrency is bounded by a simple worker pool rather than a batching loop:
 * batches idle the whole pool waiting for the slowest member, and trials differ
 * in duration by an order of magnitude when one arm times out.
 */
export async function runStudy(options: RunStudyOptions): Promise<StudyReport> {
  const deps: SchedulerDeps = {
    ensureRepo,
    ensureTaskIntent,
    completedRefs,
    runTrialProcess: forkTrial,
    ...options.deps,
  };

  const { study, ep, root } = options;
  const digest = studyDigest(study);
  mkdirSync(root, { recursive: true });
  const progressPath = join(root, 'progress.jsonl');

  const emit = (event: ProgressEvent): void => {
    appendProgress(progressPath, event);
    options.onEvent?.(event);
  };

  const planned = planTrials(study);
  emit({ at: new Date().toISOString(), kind: 'study', digest, trials: planned.length, budgetUsd: study.budgetUsd });

  await deps.ensureRepo(ep);

  const intents = new Map<string, TaskIntent>();
  const tasks = new Map(study.tasks.map((t) => [t.id, t]));
  for (const task of study.tasks) {
    const resolved = options.resolveTask(task);
    const intent = await deps.ensureTaskIntent(ep, digest, task, `${resolved.title}\n\n${resolved.body}`);
    intents.set(task.id, intent);
    emit({ at: new Date().toISOString(), kind: 'intent', taskId: task.id, intentId: intent.intentId, created: intent.created });
  }

  // A study whose tasks all carry a grader expects every trial to be scored, so
  // an unscored run is unfinished work rather than a completed cell.
  const grades = study.tasks.every((t) => Boolean(t.grader));
  const done = await deps.completedRefs(
    ep,
    [...intents.values()].map((i) => i.intentId),
    undefined,
    { requireEval: grades },
  );
  const remaining: PlannedTrial[] = [];
  let skipped = 0;
  for (const trial of planned) {
    if (done.has(trial.externalRef)) {
      skipped += 1;
      emit({ at: new Date().toISOString(), kind: 'skipped', externalRef: trial.externalRef, reason: 'already-verified' });
      continue;
    }
    remaining.push(trial);
  }

  const spend: Spend = { usd: 0, unpriced: 0 };
  const results: TrialResult[] = [];
  let failed = 0;
  let budgetStopped = false;
  let cursor = 0;

  const takeNext = (): PlannedTrial | undefined => {
    // Checked here, under the same lock as taking work, so two workers cannot
    // both see room for the last trial.
    if (spend.usd >= study.budgetUsd) {
      if (!budgetStopped) {
        budgetStopped = true;
        emit({
          at: new Date().toISOString(),
          kind: 'budget-stop',
          spentUsd: spend.usd,
          budgetUsd: study.budgetUsd,
          remaining: remaining.length - cursor,
          unpriced: spend.unpriced,
        });
      }
      return undefined;
    }
    return remaining[cursor++];
  };

  const worker = async (): Promise<void> => {
    for (let trial = takeNext(); trial; trial = takeNext()) {
      const task = tasks.get(trial.taskId)!;
      const intent = intents.get(trial.taskId)!;
      const resolved = options.resolveTask(task);
      const outDir = join(root, 'trials', trial.externalRef.replace(/[^a-zA-Z0-9._-]/g, '-'));

      emit({ at: new Date().toISOString(), kind: 'started', externalRef: trial.externalRef });

      try {
        const result = await deps.runTrialProcess({
          trial,
          outDir,
          env: {},
          argv: [
            `--adp-url=${ep.baseUrl}`,
            `--owner=${ep.owner}`,
            `--repo=${ep.repo}`,
            `--token-env=${ep.tokenEnv}`,
            `--issue=${intent.issueNumber}`,
            `--intent=${intent.intentId}`,
            `--study=${options.specPath ?? join(options.root, 'study.json')}`,
            `--arm=${trial.armId}`,
            `--task=${trial.taskId}`,
            `--rep=${trial.rep}`,
            `--seed=${resolved.seed}`,
            `--out=${outDir}`,
            `--external-ref=${trial.externalRef}`,
          ],
        });

        results.push(result);
        const { usd } = priceTrial(result, options.priceTable);
        if (usd === null) spend.unpriced += 1;
        else spend.usd += usd;

        emit({
          at: new Date().toISOString(),
          kind: 'finished',
          externalRef: trial.externalRef,
          outcome: result.outcome,
          verified: result.verified,
          ...(result.runId ? { runId: result.runId } : {}),
          usd,
        });
      } catch (error) {
        failed += 1;
        emit({
          at: new Date().toISOString(),
          kind: 'failed',
          externalRef: trial.externalRef,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // A resolved copy of the spec, for the record rather than for the children:
  // it is what a reader needs to see what actually ran, while the children are
  // given the original path so relative references still mean what they said.
  writeFileSync(join(root, 'study.json'), `${JSON.stringify(study, null, 2)}\n`);

  const width = Math.max(1, Math.min(study.concurrency, remaining.length || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));

  return {
    studyDigest: digest,
    planned: planned.length,
    skipped,
    ran: results.length,
    failed,
    spend,
    budgetStopped,
    results,
    bands: bandResults(results),
  };
}

/** One trial, in its own process, with its own credentials and cwd. */
function forkTrial(launch: TrialLaunch): Promise<TrialResult> {
  mkdirSync(launch.outDir, { recursive: true });
  const logPath = join(launch.outDir, 'child.log');
  writeFileSync(logPath, '');

  return new Promise<TrialResult>((resolvePromise, reject) => {
    const child: ChildProcess = fork(childEntry(), launch.argv, {
      env: { ...process.env, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.on('data', (d: Buffer) => appendFileSync(logPath, d));
    child.stderr?.on('data', (d: Buffer) => appendFileSync(logPath, d));

    let settled = false;
    child.on('message', (raw) => {
      const message = raw as TrialChildMessage;
      if (settled) return;
      settled = true;
      if (message.t === 'result') resolvePromise(message.result);
      else reject(new Error(message.message));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      // A child killed before it reported is exactly the crash resumption is
      // for: the run it opened is still in ADP, and a rerun rejoins it by
      // `external_ref` rather than opening a second one.
      reject(new Error(`trial process exited ${signal ? `on ${signal}` : `with code ${code}`} before reporting`));
    });
  });
}

/** The git remote a trial pushes to. Re-exported so callers need one import. */
export { gitRemote };
