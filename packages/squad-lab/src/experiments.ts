/**
 * An experiment is one ADP intent and N ADP runs.
 *
 * That framing is the whole design. ADP already aggregates and ranks those runs
 * (`GET /runs/compare?intent_id=`), so the lab stores **nothing ADP can
 * answer** — no scores, no token counts, no cost, no comparison table.
 * Re-deriving any of it here would create a second source of truth, and the two
 * would disagree in front of someone.
 *
 * What is left is the handful of things ADP has no place for: the forward
 * pointer from an experiment to the intent it minted, the grader file's digest,
 * which vendor each variant was launched on, and live process state.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { abandonRun, createGoal, ensureRepo, gitRemote, whoami, type AdpEndpoint } from './adp.js';
import { assertSeparateIdentities, gradeVariant, type GradeRecord } from './grader.js';
import { prepareWorkspace } from './isolate.js';
import type { HarnessImpl, SystemPromptMode, ToolSurface } from './harness.js';
import { DEFAULT_AGENTS, DEFAULT_ROUTING } from './defaults.js';
import { defaultTools } from './tools/default.js';
import type { AgentSpec, RoutingRule, VariantPhase, VariantResult } from './run-variant.js';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

export type ExperimentStatus = 'draft' | 'running' | 'complete' | 'failed';

export interface VariantPlan {
  id: string;
  provider: SquadProvider;
  model?: string;
  tier?: 'premium' | 'standard' | 'fast';
  /**
   * Which agent loop drives this variant, overriding the experiment's own.
   *
   * The harness is an experiment-wide setting by default, because varying it
   * *accidentally* between variants is the confound this whole file exists to
   * prevent. Varying it deliberately is the opposite: one model, one charter,
   * one tool surface, two loops, and the difference is the scaffold. That
   * comparison is unreachable without this field, and the summary bands the
   * arms rather than ranking across them.
   */
  harnessImpl?: HarnessImpl;
  /** `${experimentId}:${id}` — the run's idempotency key. */
  externalRef: string;
}

export interface Experiment {
  id: string;
  createdAt: string;
  status: ExperimentStatus;
  goal: { title: string; body: string };
  adp: { url: string; owner: string; repo: string; issueNumber: number; intentId: string; tokenEnv: string };
  seed: { repoUrl: string; ref?: string };
  grader?: { path: string; sha256: string; primaryAxis?: string };
  agents: AgentSpec[];
  routing: RoutingRule[];
  /**
   * The tools the lab registered for this experiment.
   *
   * Recorded because a backend adds tools of its own, and telling the two
   * apart afterwards has to be a lookup against what we actually supplied
   * rather than a guess from the tool's name.
   */
  registeredTools: string[];
  variants: VariantPlan[];
  limits?: { turnTimeoutMs?: number; deadlineMs?: number; graceMs?: number };
  /**
   * How the agents are driven, held identical across every variant.
   *
   * These are the two settings that decide whether a cross-vendor score is a
   * comparison at all, so they belong to the *experiment* rather than to a
   * variant: varying them between variants is a different experiment, and one
   * whose result would look exactly the same.
   */
  harness?: {
    toolSurface?: ToolSurface;
    systemPrompt?: SystemPromptMode;
    maxToolRounds?: number;
    harnessImpl?: HarnessImpl;
  };
}

/** Live process state, which ADP has no concept of and should not grow one. */
export interface VariantState {
  id: string;
  phase: VariantPhase | 'queued' | 'cancelled';
  pid?: number;
  runId?: string;
  finalSha?: string | null;
  startedAt?: string;
  endedAt?: string;
  outcome?: VariantResult['outcome'];
  error?: string;
  /**
   * Enough of the grade to render a row without re-reading `grade.json`. The
   * scores themselves stay in ADP: a second copy here would be a second source
   * of truth, and the two would disagree eventually.
   */
  grade?: { outcome: GradeRecord['outcome']; reason?: string; specDigest?: string; axes?: string[] };
}

export function labRoot(): string {
  return process.env['SQUAD_LAB_HOME'] ?? join(homedir(), '.squad-lab');
}

const expDir = (id: string) => join(labRoot(), 'experiments', id);
const variantDir = (id: string, vid: string) => join(expDir(id), 'variants', vid);

/** Where an experiment's records live. Exported for the SSE frame log. */
export function experimentDir(id: string): string {
  return expDir(id);
}

/**
 * Write-then-rename, so a reader never sees a half-written record. These files
 * are the only durable state the lab has; a torn one is worse than a missing
 * one because it looks readable.
 */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function saveExperiment(exp: Experiment): void {
  writeJson(join(expDir(exp.id), 'experiment.json'), exp);
}

export function loadExperiment(id: string): Experiment {
  return readJson<Experiment>(join(expDir(id), 'experiment.json'));
}

export function listExperiments(): Experiment[] {
  const root = join(labRoot(), 'experiments');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, 'experiment.json')))
    .map((id) => loadExperiment(id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveVariantState(experimentId: string, state: VariantState): void {
  writeJson(join(variantDir(experimentId, state.id), 'variant.json'), state);
}

export function loadVariantStates(experimentId: string): VariantState[] {
  const root = join(expDir(experimentId), 'variants');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((vid) => existsSync(join(root, vid, 'variant.json')))
    .map((vid) => readJson<VariantState>(join(root, vid, 'variant.json')));
}

export interface CreateExperimentInput {
  goal: { title: string; body: string };
  adp: AdpEndpoint & { tokenEnv: string };
  seed: { repoUrl: string; ref?: string };
  variants: {
    id?: string;
    provider: SquadProvider;
    model?: string;
    tier?: 'premium' | 'standard' | 'fast';
    harnessImpl?: HarnessImpl;
  }[];
  grader?: { path: string; primaryAxis?: string };
  agents?: AgentSpec[];
  routing?: RoutingRule[];
  limits?: Experiment['limits'];
  harness?: Experiment['harness'];
  id?: string;
}

/**
 * Set the goal up, and stop.
 *
 * No processes start here. A bad grader path or an unreachable ADP fails before
 * any model is invoked, which is the difference between a typo and a bill.
 *
 * A fresh experiment id per launch is deliberate: `external_ref` is a run's
 * idempotency key and `openRun` returns 409 for one whose run is closed, so
 * reusing an id would make a relaunch fail rather than start.
 */
export async function createExperiment(input: CreateExperimentInput): Promise<Experiment> {
  const id = input.id ?? `exp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  if (input.grader && !existsSync(resolve(input.grader.path))) {
    throw new Error(`grader not found: ${input.grader.path}`);
  }
  if (!existsSync(resolve(input.seed.repoUrl))) {
    throw new Error(`seed repo not found: ${input.seed.repoUrl}`);
  }
  if (input.variants.length === 0) throw new Error('an experiment needs at least one variant');

  await whoami(input.adp);
  await ensureRepo(input.adp);
  const goal = await createGoal(input.adp, input.goal.title, input.goal.body);

  const seen = new Set<string>();
  const variants: VariantPlan[] = input.variants.map((v, i) => {
    // Two variants on one vendor is a legitimate experiment (two tiers, two
    // harnesses, or two attempts), so the id has to stay unique without
    // assuming one per vendor. The harness joins the name whenever a variant
    // names its own: `anthropic-standard` twice, differing only by a suffix
    // nothing explains, is a summary nobody can read.
    let vid = v.id ?? [v.provider, v.tier, v.harnessImpl].filter(Boolean).join('-');
    if (seen.has(vid)) vid = `${vid}-${i + 1}`;
    seen.add(vid);
    return {
      id: vid,
      provider: v.provider,
      ...(v.model ? { model: v.model } : {}),
      ...(v.tier ? { tier: v.tier } : {}),
      ...(v.harnessImpl ? { harnessImpl: v.harnessImpl } : {}),
      externalRef: `${id}:${vid}`,
    };
  });

  const experiment: Experiment = {
    id,
    createdAt: new Date().toISOString(),
    status: 'draft',
    goal: input.goal,
    adp: {
      url: input.adp.baseUrl,
      owner: input.adp.owner,
      repo: input.adp.repo,
      issueNumber: goal.issueNumber,
      intentId: goal.intentId,
      tokenEnv: input.adp.tokenEnv,
    },
    seed: { repoUrl: resolve(input.seed.repoUrl), ...(input.seed.ref ? { ref: input.seed.ref } : {}) },
    ...(input.grader
      ? {
          grader: {
            path: resolve(input.grader.path),
            // The digest of the grader *file*, so an edit between variant one
            // and variant three changes the rubric identity rather than
            // silently ranking runs scored under two different ones.
            sha256: createHash('sha256').update(readFileSync(resolve(input.grader.path))).digest('hex'),
            ...(input.grader.primaryAxis ? { primaryAxis: input.grader.primaryAxis } : {}),
          },
        }
      : {}),
    agents: input.agents ?? DEFAULT_AGENTS,
    routing: input.routing ?? DEFAULT_ROUTING,
    registeredTools: defaultTools('/').map((t) => t.name),
    variants,
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
  };

  saveExperiment(experiment);
  for (const v of variants) saveVariantState(id, { id: v.id, phase: 'queued' });
  return experiment;
}

export interface LaunchOptions {
  token: string;
  /**
   * The grader's token, which must resolve to a different login.
   *
   * Required whenever the experiment has a grader: a launch that spends money
   * and then finds it cannot score anything has failed at the cheapest possible
   * moment to have failed instead.
   */
  evalToken?: string;
  /** Run variants one at a time. Slower, and removes every isolation risk but cwd. */
  sequential?: boolean;
  /**
   * Most variants in flight at once. Defaults to all of them.
   *
   * Matters for any experiment large enough to be a study: forty concurrent
   * agents share one machine and one rate limit, and the durations they record
   * then describe the contention rather than the work.
   */
  maxConcurrency?: number;
  credentials?: Record<string, { geminiApiKey?: string; anthropicApiKey?: string }>;
  onPhase?: (variantId: string, phase: string, detail?: unknown) => void;
  onEvent?: (variantId: string, event: unknown) => void;
  onGrade?: (variantId: string, grade: GradeRecord) => void;
}

/** What the parent and the forked child say to each other. */
export type ChildMessage =
  | { t: 'phase'; phase: VariantPhase; detail?: unknown }
  | { t: 'bus'; event: unknown }
  | { t: 'result'; result: VariantResult }
  | { t: 'error'; message: string };

const childEntry = () =>
  join(dirname(fileURLToPath(import.meta.url)), 'variant-child.js');

/**
 * Fan out, one child process per variant.
 *
 * A child rather than an in-process call for four independent reasons, each
 * sufficient on its own: API keys and the credential chain are per-process;
 * cwd is per-process; a hung backend needs a real `SIGKILL` because
 * `session.abort()` is only cooperative; and a variant that dies must not take
 * the other variants' event streams down with it.
 */
export async function launchExperiment(
  experiment: Experiment,
  options: LaunchOptions,
): Promise<VariantResult[]> {
  const evalEndpoint = await resolveEvalEndpoint(experiment, options);
  assertVendorCredentials(experiment, options);

  experiment.status = 'running';
  saveExperiment(experiment);

  const runOne = async (plan: VariantPlan) => {
    const result = await runVariantChild(experiment, plan, options);
    // Grade as each variant lands rather than in a second pass at the end: a
    // long experiment should not hold every score back until its slowest
    // variant finishes, and a crash after variant one should not lose it.
    await gradeIfConfigured(experiment, plan, result, evalEndpoint, options);
    return result;
  };
  // `sequential` is the same thing as a pool of one, and saying so keeps one
  // scheduler rather than two.
  const limit = options.sequential ? 1 : Math.max(1, options.maxConcurrency ?? experiment.variants.length);
  const results = await pooled(experiment.variants, limit, runOne);

  experiment.status = results.every((r) => r.outcome === 'error') ? 'failed' : 'complete';
  saveExperiment(experiment);
  return results;
}

/**
 * Run at most `limit` variants at once, preserving input order in the results.
 *
 * Unbounded fan-out is fine for the four-cell experiments this started as and
 * wrong for a study: forty agents on one machine contend for CPU, file handles
 * and the same rate limit, and every duration the run records then measures the
 * contention instead of the work. A variance study whose noise floor is its own
 * scheduler cannot answer the question it was built to ask.
 */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The arm a variant runs under: its own if it names one, else the experiment's. */
export function harnessImplFor(experiment: Experiment, plan: VariantPlan): HarnessImpl | undefined {
  return plan.harnessImpl ?? experiment.harness?.harnessImpl;
}

/**
 * Every vendor key the launch will need, checked before the first clone.
 *
 * The native Anthropic arm inherits the `claude` CLI's credential chain and so
 * needs nothing here. Every other cell needs a key in hand, and the moment to
 * discover it is missing is now — not after three sibling variants have run to
 * completion and spent real money, which is what happened when the server
 * forwarded no credentials at all.
 */
function assertVendorCredentials(experiment: Experiment, options: LaunchOptions): void {
  const missing: string[] = [];
  for (const plan of experiment.variants) {
    const creds = options.credentials?.[plan.id] ?? options.credentials?.[plan.provider] ?? {};
    const impl = harnessImplFor(experiment, plan) ?? 'squad-native';
    const needed = plan.provider === 'gemini' ? creds.geminiApiKey : creds.anthropicApiKey;
    if (needed) continue;
    // The one exemption, and it is the harness's doing rather than the vendor's.
    if (plan.provider === 'anthropic' && impl === 'squad-native') continue;
    missing.push(`${plan.id} (${plan.provider}, ${impl})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `no vendor key for ${missing.join(', ')} — the lab holds no usable credential for ` +
        'these variants, and a launch that spends on its siblings first has failed later than it had to',
    );
  }
}

/**
 * Live variant children, so cancelling reaches a real process.
 *
 * In-memory on purpose: a pid that outlived the lab belongs to a process this
 * lab no longer supervises, and signalling a recycled pid is worse than
 * admitting there is nothing left to stop.
 */
const liveChildren = new Map<string, Map<string, ChildProcess>>();

function track(experimentId: string, variantId: string, child: ChildProcess): void {
  const byVariant = liveChildren.get(experimentId) ?? new Map<string, ChildProcess>();
  byVariant.set(variantId, child);
  liveChildren.set(experimentId, byVariant);
}

function untrack(experimentId: string, variantId: string): void {
  const byVariant = liveChildren.get(experimentId);
  if (!byVariant) return;
  byVariant.delete(variantId);
  if (byVariant.size === 0) liveChildren.delete(experimentId);
}

export interface CancelResult {
  signalled: string[];
  killed: string[];
  abandoned: { variantId: string; runId: string }[];
  abandonErrors: { variantId: string; runId: string; error: string }[];
}

/**
 * Stop an experiment: signal, escalate, then close the books in ADP.
 *
 * `SIGTERM` first because `session.abort()` is cooperative and a backend given
 * a moment will unwind its own turn; `SIGKILL` after the grace because a wedged
 * native call will not. Both matter — killing immediately loses the trajectory
 * the child had not yet flushed, and waiting forever is not cancelling.
 *
 * Then every run the cancelled variants had opened is **abandoned, not closed**.
 * A cancelled run produced no commit to attest to, and closing one against
 * nothing would sign a statement about no particular state. Abandoning keeps
 * the trajectory — which is exactly the run someone will want to read after
 * cancelling.
 */
export async function cancelExperiment(
  experimentId: string,
  options: { token: string; graceMs?: number } = { token: '' },
): Promise<CancelResult> {
  const experiment = loadExperiment(experimentId);
  const result: CancelResult = { signalled: [], killed: [], abandoned: [], abandonErrors: [] };

  const byVariant = liveChildren.get(experimentId) ?? new Map<string, ChildProcess>();
  const stopping = [...byVariant.entries()].map(async ([variantId, child]) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    result.signalled.push(variantId);
    const exited = await waitForExit(child, options.graceMs ?? 5_000);
    if (!exited) {
      child.kill('SIGKILL');
      result.killed.push(variantId);
    }
  });
  await Promise.all(stopping);

  for (const state of loadVariantStates(experimentId)) {
    if (state.phase === 'done' || state.phase === 'cancelled') continue;
    state.phase = 'cancelled';
    state.endedAt = state.endedAt ?? new Date().toISOString();
    saveVariantState(experimentId, state);
  }

  if (options.token) {
    const endpoint: AdpEndpoint = {
      baseUrl: experiment.adp.url,
      token: options.token,
      owner: experiment.adp.owner,
      repo: experiment.adp.repo,
    };
    for (const state of loadVariantStates(experimentId)) {
      if (!state.runId) continue;
      try {
        await abandonRun(endpoint, state.runId, 'cancelled by the lab');
        result.abandoned.push({ variantId: state.id, runId: state.runId });
      } catch (err) {
        // A run already closed or abandoned answers 409, which is not a failure
        // to cancel — it is the run already being in a terminal state.
        result.abandonErrors.push({
          variantId: state.id,
          runId: state.runId,
          error: (err as Error).message,
        });
      }
    }
  }

  experiment.status = 'failed';
  saveExperiment(experiment);
  return result;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

/**
 * Settle the scoring identity before a single model call is made.
 *
 * Two failures are caught here rather than after the bill: no eval token for an
 * experiment that has a grader, and an eval token that turns out to be the same
 * principal as the runner's. The second is the dangerous one — it produces
 * evals that are indistinguishable from independent scores at a glance and are
 * self-reports underneath.
 */
async function resolveEvalEndpoint(
  experiment: Experiment,
  options: LaunchOptions,
): Promise<AdpEndpoint | undefined> {
  if (!experiment.grader) return undefined;

  const runner: AdpEndpoint = {
    baseUrl: experiment.adp.url,
    token: options.token,
    owner: experiment.adp.owner,
    repo: experiment.adp.repo,
  };
  if (!options.evalToken) {
    throw new Error(
      'this experiment has a grader but no eval token — scoring a run with the identity that ' +
        'opened it is a self-report, so set the grader identity before launching',
    );
  }
  const grader: AdpEndpoint = { ...runner, token: options.evalToken };
  await assertSeparateIdentities(runner, grader);
  return grader;
}

async function gradeIfConfigured(
  experiment: Experiment,
  plan: VariantPlan,
  result: VariantResult,
  evalEndpoint: AdpEndpoint | undefined,
  options: LaunchOptions,
): Promise<void> {
  if (!experiment.grader) return;
  const outDir = variantDir(experiment.id, plan.id);

  const grade = await gradeVariant({
    graderPath: experiment.grader.path,
    graderSha256: experiment.grader.sha256,
    ...(experiment.grader.primaryAxis ? { primaryAxis: experiment.grader.primaryAxis } : {}),
    workRepo: join(outDir, 'work'),
    runId: result.runId ?? null,
    outDir,
    ...(result.finalSha ? { gitSha: result.finalSha } : {}),
    ...(evalEndpoint ? { evalEndpoint } : {}),
  });

  recordGrade(experiment.id, plan.id, grade);
  options.onGrade?.(plan.id, grade);
}

/** Fold a grade into the variant's live state without disturbing the rest of it. */
function recordGrade(experimentId: string, variantId: string, grade: GradeRecord): void {
  const path = join(variantDir(experimentId, variantId), 'variant.json');
  const state = existsSync(path) ? readJson<VariantState>(path) : { id: variantId, phase: 'queued' as const };
  state.grade = {
    outcome: grade.outcome,
    ...(grade.reason ? { reason: grade.reason } : {}),
    ...(grade.specDigest ? { specDigest: grade.specDigest } : {}),
    ...(grade.axes ? { axes: grade.axes.filter((a) => a.posted).map((a) => a.axis) } : {}),
  };
  saveVariantState(experimentId, state);
}

/**
 * Score a variant again against the run it already produced.
 *
 * Evals are append-only and resolve latest-per-name, so a regrade after a
 * grader fix supersedes the old score rather than competing with it — and the
 * new `spec_digest` says out loud that the rubric changed.
 */
export async function regradeVariant(
  experimentId: string,
  variantId: string,
  options: { token: string; evalToken: string },
): Promise<GradeRecord> {
  const experiment = loadExperiment(experimentId);
  if (!experiment.grader) throw new Error(`experiment ${experimentId} has no grader`);

  const plan = experiment.variants.find((v) => v.id === variantId);
  if (!plan) throw new Error(`no variant '${variantId}' in ${experimentId}`);

  // Re-digest the file rather than trusting the record: regrading is the one
  // moment the grader is most likely to have been edited, and pinning the old
  // digest onto new content is exactly the confusion the digest exists to stop.
  const graderSha256 = createHash('sha256').update(readFileSync(experiment.grader.path)).digest('hex');

  const evalEndpoint = await resolveEvalEndpoint(experiment, options);
  const state = loadVariantStates(experimentId).find((s) => s.id === variantId);
  const outDir = variantDir(experimentId, variantId);

  const grade = await gradeVariant({
    graderPath: experiment.grader.path,
    graderSha256,
    ...(experiment.grader.primaryAxis ? { primaryAxis: experiment.grader.primaryAxis } : {}),
    workRepo: join(outDir, 'work'),
    runId: state?.runId ?? null,
    outDir,
    ...(state?.finalSha ? { gitSha: state.finalSha } : {}),
    ...(evalEndpoint ? { evalEndpoint } : {}),
  });

  recordGrade(experimentId, variantId, grade);
  return grade;
}

function runVariantChild(
  experiment: Experiment,
  plan: VariantPlan,
  options: LaunchOptions,
): Promise<VariantResult> {
  const outDir = variantDir(experiment.id, plan.id);
  mkdirSync(outDir, { recursive: true });

  const endpoint: AdpEndpoint = {
    baseUrl: experiment.adp.url,
    token: options.token,
    owner: experiment.adp.owner,
    repo: experiment.adp.repo,
  };

  const workspace = prepareWorkspace({
    workDir: join(outDir, 'work'),
    seedRepo: experiment.seed.repoUrl,
    branch: `lab/${experiment.id}/${plan.id}`,
    ...(experiment.seed.ref ? { seedRef: experiment.seed.ref } : {}),
    pushRemote: gitRemote(endpoint),
    adp: {
      url: experiment.adp.url,
      repo: `${experiment.adp.owner}/${experiment.adp.repo}`,
      tokenEnv: experiment.adp.tokenEnv,
    },
  });

  const state: VariantState = { id: plan.id, phase: 'queued', startedAt: new Date().toISOString() };
  saveVariantState(experiment.id, state);

  return new Promise<VariantResult>((resolvePromise) => {
    const child: ChildProcess = fork(childEntry(), [], {
      // The token reaches the child through the env var the workspace's
      // `.squad/config.json` *names*, so it is never written to disk.
      env: { ...process.env, [experiment.adp.tokenEnv]: options.token },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    track(experiment.id, plan.id, child);

    const logPath = join(outDir, 'child.log');
    writeFileSync(logPath, '');
    child.stdout?.on('data', (d) => appendLog(logPath, d));
    child.stderr?.on('data', (d) => appendLog(logPath, d));

    let settled = false;
    const finish = (result: VariantResult) => {
      if (settled) return;
      settled = true;
      untrack(experiment.id, plan.id);
      state.phase = result.outcome === 'error' ? 'failed' : 'done';
      state.outcome = result.outcome;
      state.runId = result.runId ?? '';
      state.finalSha = result.finalSha;
      state.endedAt = new Date().toISOString();
      if (result.error) state.error = result.error;
      saveVariantState(experiment.id, state);
      resolvePromise(result);
    };

    child.on('message', (raw) => {
      const msg = raw as ChildMessage;
      if (msg.t === 'phase') {
        state.phase = msg.phase;
        state.pid = child.pid ?? 0;
        saveVariantState(experiment.id, state);
        options.onPhase?.(plan.id, msg.phase, msg.detail);
      } else if (msg.t === 'bus') {
        options.onEvent?.(plan.id, msg.event);
      } else if (msg.t === 'result') {
        finish(msg.result);
      } else if (msg.t === 'error') {
        finish(errorResult(experiment, plan, msg.message));
      }
    });

    // A child that dies without reporting is still an outcome, not a hang.
    child.on('exit', (code, signal) => {
      finish(errorResult(experiment, plan, `child exited (code=${code}, signal=${signal}) without a result`));
    });
    child.on('error', (err) => finish(errorResult(experiment, plan, err.message)));

    child.send({
      t: 'start',
      spec: {
        experimentId: experiment.id,
        variantId: plan.id,
        provider: plan.provider,
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.tier ? { tier: plan.tier } : {}),
        credentials: options.credentials?.[plan.id] ?? options.credentials?.[plan.provider] ?? {},
        adp: {
          ...endpoint,
          issueNumber: experiment.adp.issueNumber,
          intentId: experiment.adp.intentId,
          tokenEnv: experiment.adp.tokenEnv,
        },
        externalRef: plan.externalRef,
        workspace,
        outDir,
        agents: experiment.agents,
        routing: experiment.routing,
        ...(experiment.limits ? { limits: experiment.limits } : {}),
        ...(experiment.harness?.toolSurface ? { toolSurface: experiment.harness.toolSurface } : {}),
        ...(experiment.harness?.systemPrompt ? { systemPrompt: experiment.harness.systemPrompt } : {}),
        ...(experiment.harness?.maxToolRounds ? { maxToolRounds: experiment.harness.maxToolRounds } : {}),
        // The variant's own arm wins over the experiment's default, which is
        // what makes "same model, both harnesses" one experiment.
        ...(harnessImplFor(experiment, plan) ? { harnessImpl: harnessImplFor(experiment, plan) } : {}),
      },
    });
  });
}

function appendLog(path: string, chunk: Buffer | string): void {
  writeFileSync(path, chunk, { flag: 'a' });
}

function errorResult(experiment: Experiment, plan: VariantPlan, message: string): VariantResult {
  return {
    experimentId: experiment.id,
    variantId: plan.id,
    provider: plan.provider,
    model: plan.model ?? '',
    externalRef: plan.externalRef,
    finalSha: null,
    outcome: 'error',
    agents: {},
    wallClockMs: 0,
    timeToQuiescenceMs: 0,
    testPassed: null,
    cost: {},
    error: message,
  };
}
