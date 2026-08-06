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

import { createGoal, ensureRepo, gitRemote, whoami, type AdpEndpoint } from './adp.js';
import { prepareWorkspace } from './isolate.js';
import { DEFAULT_AGENTS, DEFAULT_ROUTING } from './defaults.js';
import type { AgentSpec, RoutingRule, VariantPhase, VariantResult } from './run-variant.js';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

export type ExperimentStatus = 'draft' | 'running' | 'complete' | 'failed';

export interface VariantPlan {
  id: string;
  provider: SquadProvider;
  model?: string;
  tier?: 'premium' | 'standard' | 'fast';
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
  variants: VariantPlan[];
  limits?: { turnTimeoutMs?: number; deadlineMs?: number; graceMs?: number };
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
}

export function labRoot(): string {
  return process.env['SQUAD_LAB_HOME'] ?? join(homedir(), '.squad-lab');
}

const expDir = (id: string) => join(labRoot(), 'experiments', id);
const variantDir = (id: string, vid: string) => join(expDir(id), 'variants', vid);

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
  variants: { id?: string; provider: SquadProvider; model?: string; tier?: 'premium' | 'standard' | 'fast' }[];
  grader?: { path: string; primaryAxis?: string };
  agents?: AgentSpec[];
  routing?: RoutingRule[];
  limits?: Experiment['limits'];
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
    // Two variants on one vendor is a legitimate experiment (two tiers, or two
    // attempts), so the id has to stay unique without assuming one per vendor.
    let vid = v.id ?? (v.tier ? `${v.provider}-${v.tier}` : v.provider);
    if (seen.has(vid)) vid = `${vid}-${i + 1}`;
    seen.add(vid);
    return {
      id: vid,
      provider: v.provider,
      ...(v.model ? { model: v.model } : {}),
      ...(v.tier ? { tier: v.tier } : {}),
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
    variants,
    ...(input.limits ? { limits: input.limits } : {}),
  };

  saveExperiment(experiment);
  for (const v of variants) saveVariantState(id, { id: v.id, phase: 'queued' });
  return experiment;
}

export interface LaunchOptions {
  token: string;
  /** Run variants one at a time. Slower, and removes every isolation risk but cwd. */
  sequential?: boolean;
  credentials?: Record<string, { geminiApiKey?: string; anthropicApiKey?: string }>;
  onPhase?: (variantId: string, phase: string, detail?: unknown) => void;
  onEvent?: (variantId: string, event: unknown) => void;
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
  experiment.status = 'running';
  saveExperiment(experiment);

  const runOne = (plan: VariantPlan) => runVariantChild(experiment, plan, options);
  const results = options.sequential
    ? await sequential(experiment.variants, runOne)
    : await Promise.all(experiment.variants.map(runOne));

  experiment.status = results.every((r) => r.outcome === 'error') ? 'failed' : 'complete';
  saveExperiment(experiment);
  return results;
}

async function sequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
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

    const logPath = join(outDir, 'child.log');
    writeFileSync(logPath, '');
    child.stdout?.on('data', (d) => appendLog(logPath, d));
    child.stderr?.on('data', (d) => appendLog(logPath, d));

    let settled = false;
    const finish = (result: VariantResult) => {
      if (settled) return;
      settled = true;
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
