/**
 * One trial — task × arm × repetition — with no coordinator anywhere in it.
 *
 * squad-lab's `run-variant.ts` drives agents by building a `SquadCoordinator`
 * and handing it the goal. That works, and it carries a hazard that is fatal to
 * a benchmark specifically. `handleMessage` runs `shouldHandleDirectly()`
 * *before* routing, against built-in patterns that fire regardless of
 * configuration, and answers the message itself when one matches — no agent
 * spawned, no tool called, an empty trajectory. `run-variant.ts` never inspects
 * `result.strategy`, so the run closes and looks like every other run.
 *
 * The patterns are not exotic. `/^config\b/i`, `/^(?:help|how do I)\b/i` and
 * the roster pattern match "Config loader should merge defaults", "Help text
 * should wrap at 80 columns", "List the team members endpoint" — ordinary
 * benchmark task titles. A study whose tasks happened to be phrased that way
 * would silently score empty runs against real ones.
 *
 * So the coordinator is not configured around here; it is absent. The runner
 * calls the arm's `SessionFactory` directly and sends the brief itself, which
 * removes the hazard by construction rather than by vigilance.
 *
 * What that costs is that the runner must now emit the lifecycle events fan-out
 * used to emit around whatever factory it was handed. Neither harness emits
 * them — `harnesses/ai-sdk.ts` says so explicitly, because emitting them itself
 * would have double-counted under the coordinator. The terminal
 * `session:destroyed` is the load-bearing one: the recorder flushes that
 * session's chain when it arrives, and without it the trajectory is short by
 * however much was still buffered.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventBus, type SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';
import { CostTracker } from '@deduvafork/squad-sdk/runtime/cost-tracker';
import {
  startAssignmentRecording,
  finishAssignmentRecording,
  type AdpRunRecorder,
} from '@deduvafork/squad-sdk/adp';
import {
  prepareWorkspace,
  commitAndPush,
  type Workspace,
  type WorkspaceSpec,
} from '@deduvafork/squad-lab/isolate';
import { defaultTools, instrument, type LabTool } from '@deduvafork/squad-lab/tools/default';
import { readGoal, verifyRun, type AdpEndpoint } from '@deduvafork/squad-lab/adp';

import { openArm, resolveArmModel, type ArmSpec, type OpenArm } from './arms/index.js';
import { buildToolset } from './twins.js';
import type { DocsGrade } from './study.js';

export type TrialPhase =
  | 'preparing'
  | 'opening-run'
  | 'running'
  | 'quiesced'
  | 'committing'
  | 'recording'
  | 'closing'
  | 'verifying'
  | 'done'
  | 'failed';

export type TrialOutcome = 'closed' | 'abandoned' | 'timeout' | 'error';

export interface TrialLimits {
  /** Ceiling on the agent's single turn. */
  turnTimeoutMs: number;
  /** Ceiling on the whole trial, measured from the first turn. */
  deadlineMs: number;
  /** How long an aborted turn is given to unwind before we stop waiting. */
  graceMs: number;
}

export const DEFAULT_TRIAL_LIMITS: TrialLimits = {
  turnTimeoutMs: 300_000,
  deadlineMs: 900_000,
  graceMs: 15_000,
};

export interface TrialSpec {
  /**
   * The run's idempotency key. Re-running the same one rejoins the run ADP
   * already opened rather than forking the trajectory into two halves that each
   * look complete.
   */
  externalRef: string;
  arm: ArmSpec;
  adp: AdpEndpoint & { issueNumber: number; intentId: string; tokenEnv: string };
  /** Where the clone goes and what it is cloned from. */
  workspace: Omit<WorkspaceSpec, 'adp'>;
  /** The single agent this trial runs. Its prompt is the charter. */
  agent: { name: string; prompt: string };
  /** Recorded at open and covered by ADP's run attestation. */
  labels?: Record<string, string>;
  /** Defaults to squad-lab's path-jailed toolset over the clone. */
  tools?: LabTool[];
  /**
   * Which toolset the agent sees, and how much it is told about it.
   *
   * `twinSeed` present means the agent meets an isomorphic twin under names it
   * has never seen — Study A's treatment. Absent is the control. `docsGrade`
   * decides what the charter says about those tools, and is the only channel
   * carrying documentation, so the two can be varied independently.
   */
  toolset?: { twinSeed?: string; docsGrade: DocsGrade };
  /** Where bus/tool logs and `trial.json` are written. */
  outDir: string;
  limits?: Partial<TrialLimits>;
  /** The vendor key, passed rather than inherited. */
  apiKey?: string;
  onEvent?: (event: SquadEvent) => void;
  onPhase?: (phase: TrialPhase, detail?: unknown) => void;
  /** Overridable for tests. Everything reaching the network lives here. */
  deps?: Partial<TrialDeps>;
}

export interface TrialDeps {
  prepareWorkspace: (spec: WorkspaceSpec) => Workspace;
  commitAndPush: (workspace: Workspace, message: string) => string | null;
  openArm: typeof openArm;
  startRecording: typeof startAssignmentRecording;
  finishRecording: typeof finishAssignmentRecording;
  readGoal: (ep: AdpEndpoint, issueNumber: number) => Promise<{ title: string; body: string }>;
  verifyRun: (ep: AdpEndpoint, runId: string) => Promise<Record<string, unknown>>;
  /** `null` when there was no commit to run a suite against. */
  runSuite: (workDir: string) => boolean | null;
}

export interface TrialResult {
  externalRef: string;
  armId: string;
  harness: string;
  provider: string;
  model: string;
  runId?: string;
  finalSha: string | null;
  outcome: TrialOutcome;
  /**
   * ADP's own verdict on the run, read back rather than assumed.
   *
   * `null` means the check could not be made — no run id, or `/verify`
   * unreachable. It is deliberately not `false`: "we could not check" and "ADP
   * says this run does not hold up" are different findings, and a gate that
   * conflates them either rejects healthy runs or accepts tampered ones.
   */
  verified: boolean | null;
  verifyDetail?: Record<string, unknown>;
  agentSessions: Record<string, string>;
  wallClockMs: number;
  /** Time inside the turn — the agent's time, not the harness's. */
  timeToQuiescenceMs: number;
  testPassed: boolean | null;
  cost: Record<string, unknown>;
  /** Which documentation grade the charter carried. */
  docsGrade?: DocsGrade;
  /** Digest of that bundle, matching the run's `tool_docs_digest` label. */
  toolDocsDigest?: string;
  error?: string;
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`trial exceeded its ${ms}ms deadline`);
    this.name = 'DeadlineError';
  }
}

const defaultDeps: TrialDeps = {
  prepareWorkspace,
  commitAndPush,
  openArm,
  startRecording: startAssignmentRecording,
  finishRecording: finishAssignmentRecording,
  readGoal,
  verifyRun,
  runSuite: () => null,
};

export async function runTrial(spec: TrialSpec): Promise<TrialResult> {
  const deps = { ...defaultDeps, ...spec.deps };
  const limits = { ...DEFAULT_TRIAL_LIMITS, ...spec.limits };
  const startedAt = Date.now();
  const phase = (p: TrialPhase, detail?: unknown) => spec.onPhase?.(p, detail);

  const result: TrialResult = {
    externalRef: spec.externalRef,
    armId: spec.arm.id,
    harness: spec.arm.harness,
    provider: spec.arm.provider,
    model: resolveArmModel(spec.arm),
    finalSha: null,
    outcome: 'error',
    verified: null,
    agentSessions: {},
    wallClockMs: 0,
    timeToQuiescenceMs: 0,
    testPassed: null,
    cost: {},
  };

  phase('preparing');
  mkdirSync(spec.outDir, { recursive: true });
  const busLog = join(spec.outDir, 'bus.jsonl');
  const toolLog = join(spec.outDir, 'tools.jsonl');
  writeFileSync(busLog, '');
  writeFileSync(toolLog, '');

  const bus = new EventBus();
  const cost = new CostTracker();
  cost.wireToEventBus(bus);

  // Ground truth straight off the bus, never through the recorder — otherwise
  // reconciling the two would only show the recorder agreeing with itself.
  bus.subscribeAll((event) => {
    appendFileSync(
      busLog,
      `${JSON.stringify({
        type: event.type,
        sessionId: event.sessionId,
        agentName: event.agentName,
        payload: event.payload,
        timestamp: event.timestamp,
      })}\n`,
    );
    spec.onEvent?.(event);
  });

  let recorder: AdpRunRecorder | undefined;
  let arm: OpenArm | undefined;
  let sessionId: string | undefined;

  try {
    const workspace = deps.prepareWorkspace({
      ...spec.workspace,
      adp: {
        url: spec.adp.baseUrl,
        repo: `${spec.adp.owner}/${spec.adp.repo}`,
        tokenEnv: spec.adp.tokenEnv,
      },
    });

    phase('opening-run');
    recorder = await deps.startRecording({
      repoRoot: workspace.workDir,
      bus,
      externalRef: spec.externalRef,
      intentId: spec.adp.intentId,
      ...(spec.labels ? { labels: spec.labels } : {}),
      onError: (error, context) => phase('recording', { adpError: `${context}: ${error.message}` }),
    });
    result.runId = recorder?.runId;

    // Built before the brief is read so a misconfigured arm fails here rather
    // than at the first turn, where it would already be inside a recorded run.
    arm = await deps.openArm(spec.arm, {
      bus,
      workingDirectory: workspace.workDir,
      ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    });
    result.model = arm.model;

    // The toolset the agent actually meets — standard or twinned — plus the
    // documentation bundle that goes into its charter. Built before the brief
    // is read so the rename map is on disk even if the turn never starts.
    const built = buildToolset(
      spec.tools ?? defaultTools(workspace.workDir),
      spec.toolset ?? { docsGrade: 'reference' },
    );
    const tools = built.tools.map((t) => instrument(t, toolLog));
    result.docsGrade = built.docs.grade;
    result.toolDocsDigest = built.docs.digest;
    if (built.renameMap) {
      // Persisted because S5 resolves recorded tool names against it to compute
      // the hallucinated-call rate. A twin whose map was lost is a trajectory
      // nobody can read.
      writeFileSync(
        join(spec.outDir, 'rename-map.json'),
        `${JSON.stringify(built.renameMap, null, 2)}\n`,
      );
    }

    // The brief comes from the issue the intent was minted from. A trial with
    // the task hardcoded would be scored against a goal its run does not claim.
    const goal = await deps.readGoal(spec.adp, spec.adp.issueNumber);
    const brief = `${goal.title}\n\n${goal.body}`;

    const session = await arm.createSession({
      model: arm.model,
      agentName: spec.agent.name,
      clientName: `squad-agent-${spec.agent.name}`,
      workingDirectory: workspace.workDir,
      tools,
      // Documentation rides in the charter, which `harnessDigest` already folds
      // — so an arm that was told more is visibly a different harness.
      systemMessage: {
        mode: 'replace',
        content: built.docs.text ? `${spec.agent.prompt}\n\n${built.docs.text}` : spec.agent.prompt,
      },
      ...(spec.arm.maxToolRounds !== undefined ? { maxToolRounds: spec.arm.maxToolRounds } : {}),
    });
    sessionId = session.sessionId;

    // What fan-out used to emit around the factory. `session:created` gives the
    // recorder the squad-session-id → ADP-session mapping up front; the
    // terminal event below is what flushes the chain.
    await emitLifecycle(bus, 'session:created', sessionId, spec.agent.name, {
      agentName: spec.agent.name,
    });

    phase('running', { model: arm.model, provider: spec.arm.provider });
    const quiescenceStart = Date.now();
    try {
      await withDeadline(
        session.sendAndWait
          ? session.sendAndWait({ prompt: brief, mode: 'immediate' }, limits.turnTimeoutMs)
          : session.sendMessage({ prompt: brief, mode: 'immediate' }),
        limits.deadlineMs,
      );
    } catch (err) {
      if (err instanceof DeadlineError) {
        result.outcome = 'timeout';
        result.error = err.message;
        try {
          await session.abort?.();
        } catch {
          // An arm that cannot abort still gets the grace period below.
        }
        await sleep(limits.graceMs);
      } else {
        throw err;
      }
    }
    result.timeToQuiescenceMs = Date.now() - quiescenceStart;
    phase('quiesced', { timeToQuiescenceMs: result.timeToQuiescenceMs });

    await emitLifecycle(bus, 'session:destroyed', sessionId, spec.agent.name, {
      reason: result.outcome === 'timeout' ? 'deadline' : 'turn complete',
    });

    // The only correct barrier between "the bus is quiet" and "ADP holds it":
    // it awaits the handler chain and the durable spool, so nothing downstream
    // has to sleep and hope.
    await recorder?.flush();

    phase('committing');
    result.finalSha = deps.commitAndPush(workspace, `feat: ${goal.title.toLowerCase()}`);
    if (result.finalSha) {
      await recorder?.recordCommit(spec.agent.name, result.finalSha, { message: goal.title });

      phase('recording');
      result.testPassed = deps.runSuite(workspace.workDir);
      if (result.testPassed !== null) {
        await recorder?.recordTestResult(spec.agent.name, {
          suite: 'node:test',
          passed: result.testPassed,
          gitSha: result.finalSha,
        });
      }
      await recorder?.flush();
    }

    for (const [agent, adpSession] of recorder?.sessionsByAgent ?? []) {
      result.agentSessions[agent] = adpSession;
    }

    phase('closing');
    await deps.finishRecording(recorder, {
      finalGitSha: result.outcome === 'timeout' ? null : result.finalSha,
      reason: result.outcome === 'timeout' ? 'deadline' : 'agent produced no commit',
    });

    if (result.outcome !== 'timeout') {
      result.outcome = result.finalSha ? 'closed' : 'abandoned';
    }
    result.cost = summarise(cost);
    phase('done', { outcome: result.outcome, runId: result.runId });
  } catch (err) {
    result.outcome = 'error';
    result.error = err instanceof Error ? err.message : String(err);
    phase('failed', { error: result.error });
    try {
      // A trial that threw still produced a trajectory, and abandoning keeps
      // it. Leaving the run open would strand it: nothing else will ever close
      // it, and an open run is neither a result nor a clean absence.
      await deps.finishRecording(recorder, { finalGitSha: null, reason: result.error });
    } catch {
      // A run we cannot close cleanly is still better recorded than lost.
    }
  } finally {
    try {
      await arm?.close();
    } catch {
      // Disconnect failures must not mask the trial's own outcome.
    }
  }

  // Read ADP's verdict back rather than inferring it from having asked. The
  // recorder swallows its own errors by design — recording must never throw
  // into the bus — so a close ADP rejected looks identical here to one it
  // accepted.
  if (result.runId) {
    phase('verifying');
    try {
      const verdict = await deps.verifyRun(spec.adp, result.runId);
      result.verifyDetail = verdict;
      result.verified = verdict.ok === true;
    } catch (error) {
      result.verified = null;
      result.verifyDetail = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  result.wallClockMs = Date.now() - startedAt;
  // Pointers and a verdict, never scores or trajectory content: ADP is the
  // record, and a local file that restated it would be a second source able to
  // disagree with the one that is attested.
  writeFileSync(join(spec.outDir, 'trial.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/**
 * Emit and wait.
 *
 * `bus.emit` resolves when every handler has been invoked, which for the
 * recorder means the event is buffered rather than merely delivered. Firing
 * these without awaiting would let the terminal event race the flush that is
 * supposed to include it.
 */
async function emitLifecycle(
  bus: EventBus,
  type: string,
  sessionId: string,
  agentName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await bus.emit({ type, sessionId, agentName, payload, timestamp: new Date() } as never);
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summarise(cost: CostTracker): Record<string, unknown> {
  const s = cost.getSummary() as {
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalEstimatedCost?: number;
    agents?: Iterable<[string, unknown]>;
    sessions?: Iterable<[string, unknown]>;
  };
  return {
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalEstimatedCost: s.totalEstimatedCost,
    agents: Object.fromEntries(s.agents ?? []),
    sessions: Object.fromEntries(s.sessions ?? []),
  };
}
