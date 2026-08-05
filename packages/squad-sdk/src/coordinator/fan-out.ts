/**
 * Parallel Fan-Out Session Spawning (M1-10, Issue #130)
 *
 * Spawns multiple agent sessions concurrently using Promise.allSettled
 * for maximum throughput. Each spawn compiles charter → resolves model
 * → creates session → sends initial message. Event aggregation collects
 * all session events into coordinator's event bus. Error isolation ensures
 * one session failure doesn't affect others.
 */

import type { AgentCharter } from '../agents/index.js';
// The runtime bus, not `../client/event-bus.js`. Every real caller
// (SquadCoordinator, SquadClient, AdpRunRecorder) passes the runtime bus, whose
// event names are colon-separated and whose subscribe method is `subscribe`.
// This file used to import the client bus — dot-separated names and `on()` —
// so the events it emitted reached `subscribeAll` but no typed subscriber, and
// the recorder dropped them at its `default` case.
import type { EventBus } from '../runtime/event-bus.js';
import type { SessionPool } from '../client/session-pool.js';
import { VALID_REASONING_EFFORTS } from '../config/models.js';
import type { CreateSessionFn, SpawnBackend, SpawnHandle, SpawnRequest } from './spawn-backend.js';

// --- Spawn Configuration ---

export interface AgentSpawnConfig {
  /** Agent name to spawn */
  agentName: string;
  /** Task description for the agent */
  task: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Additional context to pass */
  context?: string;
  /** Model override (skips resolution) */
  modelOverride?: string;
  /** Reasoning effort override */
  reasoningEffortOverride?: string;
  /**
   * Ceiling for this agent's opening turn, in ms. Omitted means no deadline,
   * which is the historical behaviour.
   *
   * `spawnParallel` resolves only once every agent's turn has, so without a
   * deadline one wedged backend hangs the whole assignment. The bound is
   * applied here rather than delegated to `session.sendAndWait`, because
   * `sendAndWait`'s timeout is honoured by the Anthropic backend and ignored by
   * the Gemini one — a deadline that works on one vendor is not a deadline when
   * the point of the exercise is comparing vendors.
   */
  timeoutMs?: number;
}

// --- Spawn Result ---

export interface SpawnResult {
  /** Agent name that was spawned */
  agentName: string;
  /** Session ID if spawn succeeded */
  sessionId?: string;
  /** Spawn outcome */
  status: 'success' | 'failed';
  /** Error message if failed */
  error?: string;
  /** Start time */
  startTime: Date;
  /** End time */
  endTime: Date;
}

// --- Charter and Model Resolution Dependencies ---

export interface FanOutDependencies {
  /** Charter compilation function */
  compileCharter: (agentName: string) => Promise<AgentCharter>;
  /** Model resolution function */
  resolveModel: (charter: AgentCharter, override?: string) => Promise<string>;
  /** Reasoning effort resolution function (optional for backwards compatibility) */
  resolveReasoningEffort?: (charter: AgentCharter, override?: string) => Promise<string | undefined>;
  /** Session creation function */
  createSession: CreateSessionFn;
  /** Session pool for tracking */
  sessionPool: SessionPool;
  /** Event bus for aggregation */
  eventBus: EventBus;
  /**
   * Optional spawn backend for platform-aware dispatch (Issue #1377).
   * When provided, spawn uses the backend's platform-specific mechanism
   * (e.g., sub-sessions in Copilot App). Falls back to createSession if absent.
   */
  spawnBackend?: SpawnBackend;
}

// --- Fan-Out Orchestrator ---

/**
 * Spawn multiple agents in parallel using Promise.allSettled.
 * 
 * Each spawn:
 * 1. Compile charter.md → AgentCharter
 * 2. Resolve model (override or charter or auto-select)
 * 3. Create session via SquadClient
 * 4. Send initial message with task and context
 * 5. Aggregate events to coordinator's event bus
 * 
 * Error isolation: one failure doesn't block others.
 * Returns SpawnResult[] with outcomes for each agent.
 * 
 * @param configs - Array of agent spawn configurations
 * @param deps - Injected dependencies (charter compiler, model resolver, client)
 * @returns Promise resolving to array of spawn results
 */
export async function spawnParallel(
  configs: AgentSpawnConfig[],
  deps: FanOutDependencies
): Promise<SpawnResult[]> {
  const spawnPromises = configs.map(config => spawnSingle(config, deps));
  const settledResults = await Promise.allSettled(spawnPromises);

  return settledResults.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      // Rejection from spawnSingle shouldn't happen (it catches internally),
      // but handle defensively
      return {
        agentName: configs[index]!.agentName,
        status: 'failed' as const,
        error: result.reason?.message || String(result.reason),
        startTime: new Date(),
        endTime: new Date(),
      };
    }
  });
}

/**
 * Spawn a single agent session.
 * Catches all errors and returns a SpawnResult (never rejects).
 */
async function spawnSingle(
  config: AgentSpawnConfig,
  deps: FanOutDependencies
): Promise<SpawnResult> {
  const startTime = new Date();

  try {
    // Step 1: Compile charter
    const charter = await deps.compileCharter(config.agentName);

    // Step 2: Resolve model
    const model = config.modelOverride
      ? config.modelOverride
      : await deps.resolveModel(charter, config.modelOverride);

    // Step 2b: Resolve reasoning effort
    const rawEffort = deps.resolveReasoningEffort
      ? await deps.resolveReasoningEffort(charter, config.reasoningEffortOverride)
      : config.reasoningEffortOverride || charter.reasoningEffort || undefined;
    // Validate: only pass through recognized effort values
    const validEfforts = VALID_REASONING_EFFORTS as readonly string[];
    const reasoningEffort = rawEffort && rawEffort !== 'auto' && validEfforts.includes(rawEffort)
      ? rawEffort
      : undefined;

    const initialPrompt = buildInitialPrompt(config);

    // Step 3: Create session
    let sessionId: string;
    let spawnHandle: SpawnHandle | undefined;

    if (deps.spawnBackend) {
      const request: SpawnRequest = {
        agentName: config.agentName,
        prompt: initialPrompt,
        description: `${config.agentName}: ${config.task}`,
        name: config.agentName,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        background: true,
      };

      const handle = await deps.spawnBackend.spawn(request);
      if (handle.success) {
        spawnHandle = handle;
        sessionId = handle.id;
      } else {
        // Graceful degradation (Issue #1377 follow-up): when the platform
        // backend (e.g. App sub-sessions) cannot spawn — concurrency cap,
        // unavailable tool, transient error — fall back to the direct
        // createSession path rather than failing the agent outright. This
        // mirrors the template contract ("if create_session fails, retry
        // with task").
        await deps.eventBus.emit({
          type: 'agent:milestone',
          sessionId: undefined,
          agentName: config.agentName,
          payload: {
            event: 'spawn.fallback',
            agentName: config.agentName,
            from: deps.spawnBackend.platform,
            reason: handle.error || 'spawn backend reported failure',
          },
          timestamp: new Date(),
        });
        sessionId = await spawnViaCreateSession(deps, config, model, reasoningEffort, initialPrompt);
      }
    } else {
      sessionId = await spawnViaCreateSession(deps, config, model, reasoningEffort, initialPrompt);
    }

    // Step 4: Register in session pool
    deps.sessionPool.add({
      id: sessionId,
      agentName: config.agentName,
      status: 'active',
      createdAt: startTime,
    });

    if (deps.spawnBackend && spawnHandle) {
      registerSpawnRelease(deps.spawnBackend, spawnHandle, deps.eventBus);
    }

    // Step 6: Emit spawn success event.
    //
    // `agentName` goes on the envelope as well as in the payload. AdpRunRecorder
    // reads the payload here but `sessionFor()` reads the envelope for every
    // other event, so an envelope without it means each agent's later events
    // resolve to the coordinator's session instead of its own.
    await deps.eventBus.emit({
      type: 'session:created',
      sessionId,
      agentName: config.agentName,
      payload: { agentName: config.agentName, priority: config.priority || 'normal' },
      timestamp: new Date(),
    });

    return {
      agentName: config.agentName,
      sessionId,
      status: 'success',
      startTime,
      endTime: new Date(),
    };
  } catch (error) {
    // Error isolation: one spawn failure doesn't affect others
    const errorMessage = error instanceof Error ? error.message : String(error);

    await deps.eventBus.emit({
      type: 'session:error',
      sessionId: undefined,
      agentName: config.agentName,
      payload: { agentName: config.agentName, error: errorMessage },
      timestamp: new Date(),
    });

    return {
      agentName: config.agentName,
      status: 'failed',
      error: errorMessage,
      startTime,
      endTime: new Date(),
    };
  }
}

/**
 * Create a session directly via the injected factory (the "task"/CLI path).
 * Used for the no-backend case and as the fallback when a platform backend
 * fails to spawn.
 */
async function spawnViaCreateSession(
  deps: FanOutDependencies,
  config: AgentSpawnConfig,
  model: string,
  reasoningEffort: string | undefined,
  initialPrompt: string,
): Promise<string> {
  const session = await deps.createSession({
    model,
    clientName: `squad-agent-${config.agentName}`,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });

  const options = { prompt: initialPrompt, mode: 'immediate' as const };

  // Both backends resolve this on *turn completion*, not on dispatch — which is
  // why `spawnParallel` awaiting it is already a real completion signal. Prefer
  // `sendAndWait` when the session offers it, because the Anthropic backend
  // implements the timeout natively and aborts the turn it started.
  const turn = session.sendAndWait
    ? session.sendAndWait(options, config.timeoutMs)
    : session.sendMessage(options);

  if (config.timeoutMs === undefined) {
    await turn;
    return session.sessionId;
  }

  // The race is belt-and-braces on purpose: the Gemini backend accepts a
  // timeout argument and ignores it, so relying on `sendAndWait` alone would
  // bound one vendor and not the other. Abort is best-effort — a backend that
  // cannot be aborted still stops blocking the assignment here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`agent turn exceeded ${config.timeoutMs}ms`)),
          config.timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    try {
      await session.abort?.();
    } catch {
      // An abort that fails must not mask the timeout that caused it.
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  return session.sessionId;
}

/**
 * Safety net (Issue #1377 follow-up): max lifetime (ms) for a spawned handle
 * before its concurrency slot is force-released. Guards against sub-sessions
 * that crash silently without emitting a terminal status event, which would
 * otherwise leak their slot forever. Generous by default so long-running
 * autopilot work is not released prematurely.
 */
const DEFAULT_SPAWN_RELEASE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function registerSpawnRelease(
  backend: SpawnBackend,
  handle: SpawnHandle,
  eventBus: EventBus,
  leakTimeoutMs: number = DEFAULT_SPAWN_RELEASE_TIMEOUT_MS,
): void {
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const releaseOnce = () => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    unsubscribeIdle();
    unsubscribeDestroyed();
    unsubscribeError();
    backend.release(handle);
  };

  // `session.status_changed` has no analogue on the runtime bus, so the
  // status-based release is gone. `session:idle` covers the case it actually
  // caught (a session going quiet without being destroyed); anything it
  // does not catch falls through to the leak timer below, which is what that
  // timer is for.
  const unsubscribeIdle = eventBus.subscribe('session:idle', (event) => {
    if (event.sessionId === handle.id) {
      releaseOnce();
    }
  });

  const unsubscribeDestroyed = eventBus.subscribe('session:destroyed', (event) => {
    if (event.sessionId === handle.id) {
      releaseOnce();
    }
  });

  const unsubscribeError = eventBus.subscribe('session:error', (event) => {
    if (event.sessionId === handle.id) {
      releaseOnce();
    }
  });

  if (leakTimeoutMs > 0) {
    timer = setTimeout(releaseOnce, leakTimeoutMs);
    // Don't let the safety timer keep the event loop alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * Maximum length (chars) for an interpolated task/context value. Caps prompt
 * bloat and bounds the blast radius of injected content.
 */
const MAX_PROMPT_VALUE_LENGTH = 8000;

/**
 * Defense-in-depth sanitizer for caller-supplied values interpolated into the
 * initial prompt (Issue #1377 follow-up). This is NOT a complete prompt-injection
 * defense — it just reduces the chance that a hostile `task`/`context` can forge
 * our structural markdown markers (e.g. an injected `**Task:**` / `**Context:**`
 * header) or smuggle control characters. It:
 *  - strips control characters (except tab/newline),
 *  - neutralizes leading `**Marker:**`-style bold headers by escaping the `**`,
 *  - caps total length.
 */
function sanitizePromptValue(value: string): string {
  if (!value) return value;

  // eslint-disable-next-line no-control-regex
  let out = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Neutralize lines that mimic our structural bold headers ("**Word:**").
  out = out.replace(/^(\s*)\*\*([^*\n]+:)\*\*/gm, '$1\\*\\*$2\\*\\*');

  if (out.length > MAX_PROMPT_VALUE_LENGTH) {
    out = out.slice(0, MAX_PROMPT_VALUE_LENGTH) + '\n…[truncated]';
  }

  return out;
}

/**
 * Build the initial prompt message for a spawned agent.
 * Includes task, priority, and optional context.
 */
function buildInitialPrompt(config: AgentSpawnConfig): string {
  const parts: string[] = [];

  if (config.priority && config.priority !== 'normal') {
    parts.push(`**Priority:** ${config.priority.toUpperCase()}`);
  }

  parts.push('', `**Task:**`, sanitizePromptValue(config.task));

  if (config.context) {
    parts.push('', `**Context:**`, sanitizePromptValue(config.context));
  }

  return parts.join('\n');
}

// `aggregateSessionEvents` used to live here. It forwarded a set of
// dot-separated event names (`message.delta`, `tool.start`, …) that are not
// SquadEventTypes and would have reached no typed subscriber. It had no caller,
// and it type-checked only because this file imported the wrong EventBus — which
// is precisely how that import survived long enough to break session attribution.
// Tool calls now reach the bus through the adapter bridge in `adapter/client.ts`.
