/**
 * One goal, one vendor, one recorded ADP run.
 *
 * This is `scratch-m7/runner.ts` with the constants lifted into a spec and the
 * workarounds either fixed upstream or removed. Two of those are worth naming,
 * because their absence here is the point:
 *
 *  - It no longer hand-emits `session:created`. Fan-out emits it on the runtime
 *    bus with the agent on the envelope, so the recorder gives each agent its
 *    own ADP session unaided.
 *  - It no longer sleeps. `handleMessage` resolves when every agent's turn has
 *    completed, so quiescence is awaited rather than guessed at — which is what
 *    makes a run's wall-clock the agents' time instead of the harness's.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventBus, type SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';
import { CostTracker } from '@deduvafork/squad-sdk/runtime/cost-tracker';
import { SquadClient } from '@deduvafork/squad-sdk/client';
import { SquadCoordinator } from '@deduvafork/squad-sdk/coordinator';
import { SessionPool } from '@deduvafork/squad-sdk/client';
import type { AgentCharter } from '@deduvafork/squad-sdk/agents';
import { VENDORS, type SquadProvider } from '@deduvafork/squad-sdk/config/vendors';
// Pinned into the harness digest: an SDK upgrade changes how the agents are
// driven, so it changes the harness, and two runs across it are not the same
// experiment however identical the configuration looks.
import { VERSION as SDK_VERSION } from '@deduvafork/squad-sdk';

import { commitAndPush, type Workspace } from './isolate.js';
import { defaultTools, instrument, type LabTool } from './tools/default.js';
import { getRun, readGoal, type AdpEndpoint } from './adp.js';
import {
  harnessLabels,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_SURFACE,
  type SystemPromptMode,
  type ToolSurface,
} from './harness.js';
import { MCP_BRIDGE_PREFIX } from './tools/taxonomy.js';

/** The name the Agent SDK matches a bridged squad tool against. */
const mcpToolName = (name: string) => `${MCP_BRIDGE_PREFIX}${name}`;

export type VariantPhase =
  | 'preparing'
  | 'opening-run'
  | 'running'
  | 'quiesced'
  | 'committing'
  | 'recording'
  | 'closing'
  | 'done'
  | 'failed';

export interface AgentSpec {
  name: string;
  role: string;
  prompt: string;
}

export interface RoutingRule {
  workType: string;
  agents: string[];
  confidence: 'high' | 'medium' | 'low';
  examples: string[];
}

export interface VariantLimits {
  /** Ceiling on one agent's opening turn. */
  turnTimeoutMs: number;
  /** Ceiling on the whole variant, measured from the first agent turn. */
  deadlineMs: number;
  /** How long an aborted turn is given to unwind before we stop waiting. */
  graceMs: number;
}

export const DEFAULT_LIMITS: VariantLimits = {
  turnTimeoutMs: 300_000,
  deadlineMs: 900_000,
  graceMs: 15_000,
};

export interface VariantSpec {
  experimentId: string;
  variantId: string;
  provider: SquadProvider;
  /** Defaults to the vendor's model for `tier`. */
  model?: string;
  tier?: 'premium' | 'standard' | 'fast';
  credentials?: { geminiApiKey?: string; anthropicApiKey?: string };

  adp: AdpEndpoint & { issueNumber: number; intentId: string; tokenEnv: string };
  /** Idempotency key for the run. Re-running the same one rejoins. */
  externalRef: string;

  workspace: Workspace;
  /** Where bus/tool logs and the result summary are written. */
  outDir: string;

  agents: AgentSpec[];
  routing: RoutingRule[];
  tools?: LabTool[];
  limits?: Partial<VariantLimits>;
  /**
   * Which tools the agents may reach for. Defaults to `registered`, so both
   * vendors see one surface and a cross-vendor score means something.
   */
  toolSurface?: ToolSurface;
  /**
   * Whose system message the agents get. Defaults to `charter-only`, so both
   * vendors receive identical instructions.
   */
  systemPrompt?: SystemPromptMode;

  onEvent?: (event: SquadEvent) => void;
  onPhase?: (phase: VariantPhase, detail?: unknown) => void;
}

export interface VariantResult {
  experimentId: string;
  variantId: string;
  provider: SquadProvider;
  model: string;
  externalRef: string;
  runId?: string;
  finalSha: string | null;
  outcome: 'closed' | 'abandoned' | 'timeout' | 'error';
  agents: Record<string, string>;
  wallClockMs: number;
  /** Time inside `handleMessage` — the agents' time, not the harness's. */
  timeToQuiescenceMs: number;
  testPassed: boolean | null;
  cost: Record<string, unknown>;
  error?: string;
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`variant exceeded its ${ms}ms deadline`);
    this.name = 'DeadlineError';
  }
}

export async function runVariant(spec: VariantSpec): Promise<VariantResult> {
  const limits = { ...DEFAULT_LIMITS, ...spec.limits };
  const tier = spec.tier ?? 'standard';
  const model = spec.model ?? VENDORS[spec.provider].models[tier];
  // Parity by default. An experiment that wants the backend's own tools has to
  // ask for them, because that is the choice which stops the result being a
  // comparison.
  const toolSurface = spec.toolSurface ?? DEFAULT_TOOL_SURFACE;
  const systemPrompt = spec.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const startedAt = Date.now();

  const phase = (p: VariantPhase, detail?: unknown) => spec.onPhase?.(p, detail);
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

  const result: VariantResult = {
    experimentId: spec.experimentId,
    variantId: spec.variantId,
    provider: spec.provider,
    model,
    externalRef: spec.externalRef,
    finalSha: null,
    outcome: 'error',
    agents: {},
    wallClockMs: 0,
    timeToQuiescenceMs: 0,
    testPassed: null,
    cost: {},
  };

  let client: SquadClient | undefined;
  let coordinator: SquadCoordinator | undefined;

  try {
    phase('opening-run');

    // The provider is passed, never written. `resolveProvider` returns an
    // explicit provider on its first line, before it reads `.squad/config.json`
    // — so two variants never race on that file, because neither touches it.
    client = new SquadClient({
      provider: spec.provider,
      ...(spec.provider === 'gemini' && spec.credentials?.geminiApiKey
        ? { geminiApiKey: spec.credentials.geminiApiKey }
        : {}),
      ...(spec.provider === 'anthropic' && spec.credentials?.anthropicApiKey
        ? { anthropicApiKey: spec.credentials.anthropicApiKey }
        : {}),
      eventBus: bus,
    } as any);
    await client.connect();

    const pool = new SessionPool();
    const tools = (spec.tools ?? defaultTools(spec.workspace.workDir)).map((t) =>
      instrument(t, toolLog),
    );
    const charters = new Map(spec.agents.map((a) => [a.name, a]));

    // Recorded on the run itself, so "the harness was held constant" is a value
    // two rows can be compared on rather than a claim in a write-up.
    const harness = harnessLabels({
      toolSurface,
      systemPrompt,
      agents: spec.agents,
      routing: spec.routing,
      tools: tools.map((t) => t.name),
      limits,
      sdkVersion: SDK_VERSION,
    });

    coordinator = new SquadCoordinator({
      config: {
        version: '1',
        models: {} as any,
        routing: { rules: spec.routing } as any,
      } as any,
      eventBus: bus,
      turnTimeoutMs: limits.turnTimeoutMs,
      adp: {
        repoRoot: spec.workspace.workDir,
        externalRef: spec.externalRef,
        intentId: spec.adp.intentId,
        // What this variant is, said once at open, where ADP signs it into the
        // run predicate. Without it a comparison has to infer the vendor by
        // parsing `externalRef` — a format nothing enforces, in a field that
        // must change whenever a variant is re-run.
        labels: {
          provider: spec.provider,
          model,
          variant: spec.variantId,
          experiment: spec.experimentId,
          ...(spec.tier ? { tier: spec.tier } : {}),
          // Two runs are comparable only if these match. Attested alongside the
          // vendor, so that is a fact a reader can check rather than one the
          // write-up asserts.
          ...harness,
        },
        onError: (error, context) => phase('recording', { adpError: `${context}: ${error.message}` }),
      },
      fanOutDeps: {
        compileCharter: async (agentName: string): Promise<AgentCharter> => {
          const a = charters.get(agentName);
          return {
            name: agentName,
            displayName: agentName,
            role: a?.role ?? 'Agent',
            expertise: [],
            style: 'concise',
            prompt: a?.prompt ?? 'You are a helpful agent.',
          } as AgentCharter;
        },
        resolveModel: async () => model,
        createSession: async (config: any) => {
          const agentName = String(config.clientName ?? '').replace(/^squad-agent-/, '');
          return (await client!.createSession({
            model: config.model,
            clientName: config.clientName,
            agentName,
            // Scopes the backend's *own* Read/Write/Edit/Bash to this variant's
            // clone. Without it those operate on the process cwd, and an agent
            // writes a correct module into entirely the wrong tree.
            workingDirectory: spec.workspace.workDir,
            tools: tools as any,
            // Naming the surface explicitly is what makes the two vendors
            // comparable. Left unset, the Anthropic backend adds its own
            // Read/Write/Edit/Glob/Grep/Bash and the Gemini backend does not,
            // so the two runs are not the same program — which is how the M7
            // slice ended up reporting a 100x token difference that was a
            // tooling difference wearing a model's name.
            ...(toolSurface === 'registered'
              ? {
                  availableTools: tools.map((t) => mcpToolName(t.name)),
                  // Both, and the second one is the one that works.
                  // `availableTools` filters permission; `builtinTools: false`
                  // is what stops the backend registering its own tools at all.
                  builtinTools: false,
                }
              : {}),
            systemMessage:
              systemPrompt === 'charter-only'
                ? // `replace` drops the backend's own preset. Without it the
                  // Anthropic agents get Claude Code's entire system message
                  // *plus* the charter while the Gemini agents get the charter
                  // alone — a confound that survives fixing the tools, and a
                  // quieter one, because nothing in the telemetry shows it.
                  { mode: 'replace' as const, content: charters.get(agentName)?.prompt ?? '' }
                : { content: charters.get(agentName)?.prompt ?? '' },
          } as any)) as any;
        },
        sessionPool: pool,
        eventBus: bus,
      } as any,
    });

    // The brief comes from the issue the intent was minted from. A variant with
    // the task hardcoded would be scored against a goal its run does not claim.
    const goal = await readGoal(spec.adp, spec.adp.issueNumber);
    const task = `${goal.title}\n\n${goal.body}`;

    phase('running', { model, provider: spec.provider });
    const quiescenceStart = Date.now();
    try {
      await withDeadline(
        coordinator.handleMessage(task, {
          sessionId: 'coordinator',
          config: {} as any,
          eventBus: bus,
        } as any),
        limits.deadlineMs,
      );
    } catch (err) {
      if (err instanceof DeadlineError) {
        result.outcome = 'timeout';
        result.error = err.message;
        await sleep(limits.graceMs);
      } else {
        throw err;
      }
    }
    result.timeToQuiescenceMs = Date.now() - quiescenceStart;
    phase('quiesced', { timeToQuiescenceMs: result.timeToQuiescenceMs });

    const recorder = coordinator.getRecorder();
    result.runId = recorder?.runId;
    // The only correct barrier between "the bus is quiet" and "ADP holds it":
    // it awaits the handler chain and the durable spool, so nothing downstream
    // has to sleep and hope.
    await recorder?.flush();

    phase('committing');
    result.finalSha = commitAndPush(spec.workspace, `feat: ${goal.title.toLowerCase()}`);
    if (result.finalSha) {
      const author = spec.agents[0]?.name ?? 'agent';
      await recorder?.recordCommit(author, result.finalSha, { message: goal.title });
    }

    phase('recording');
    if (result.finalSha) {
      // The whole suite: which file the goal added is the goal's choice, and a
      // hardcoded filename would report on something else entirely.
      result.testPassed = runSuite(spec.workspace.workDir);
      await recorder?.recordTestResult(spec.agents.at(-1)?.name ?? 'agent', {
        suite: 'node:test',
        passed: result.testPassed,
        gitSha: result.finalSha,
      });
      await recorder?.flush();
    }

    for (const [agent, sessionId] of recorder?.sessionsByAgent ?? []) {
      result.agents[agent] = sessionId;
    }

    phase('closing');
    await coordinator.finishAssignment({
      finalGitSha: result.finalSha,
      reason: result.outcome === 'timeout' ? 'deadline' : 'agents produced no commit',
    });

    // Read the run back rather than inferring the outcome from having asked.
    // The recorder swallows its own errors by design — recording must never
    // throw into the bus — so a close that ADP rejected looks identical here to
    // one it accepted, and reporting `closed` on the strength of having called
    // close is how a run that ADP still holds open gets counted as a result.
    if (result.outcome !== 'timeout' && result.runId) {
      const run = (await getRun(spec.adp, result.runId).catch(() => undefined)) as
        | { status?: string }
        | undefined;
      result.outcome =
        run?.status === 'closed'
          ? 'closed'
          : run?.status === 'abandoned'
            ? 'abandoned'
            : 'error';
      if (result.outcome === 'error' && !result.error) {
        result.error = `run left ${run?.status ?? 'unreadable'} after close`;
      }
    }

    result.cost = summarise(cost);
    phase('done', { outcome: result.outcome, runId: result.runId });
  } catch (err) {
    result.outcome = 'error';
    result.error = err instanceof Error ? err.message : String(err);
    phase('failed', { error: result.error });
    try {
      await coordinator?.finishAssignment({ finalGitSha: null, reason: result.error });
    } catch {
      // A run we cannot close cleanly is still better recorded than lost.
    }
  } finally {
    result.wallClockMs = Date.now() - startedAt;
    try {
      await client?.disconnect?.();
    } catch {
      // Disconnect failures must not mask the run's own outcome.
    }
    writeFileSync(join(spec.outDir, 'variant.json'), `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

/**
 * Bound the whole variant regardless of backend.
 *
 * The per-turn ceiling in fan-out prefers `sendAndWait`, which the Anthropic
 * backend honours and the Gemini one accepts and ignores. This is the outer
 * guarantee that does not depend on either.
 */
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

function runSuite(workDir: string): boolean {
  try {
    execFileSync('node', ['--test'], { cwd: workDir, stdio: 'pipe', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

function summarise(cost: CostTracker): Record<string, unknown> {
  const s = cost.getSummary() as any;
  return {
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalEstimatedCost: s.totalEstimatedCost,
    agents: Object.fromEntries(s.agents ?? []),
    sessions: Object.fromEntries(s.sessions ?? []),
  };
}
