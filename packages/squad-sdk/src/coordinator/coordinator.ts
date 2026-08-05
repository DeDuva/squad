/**
 * Squad Coordinator (M3-1, Issue #135)
 *
 * The brain of Squad — receives user messages, decides how to handle them,
 * and orchestrates agent spawning. Wires together:
 *   - DirectResponseHandler (no-spawn fast path)
 *   - Routing rules (matchRoute / compileRoutingRules)
 *   - Charter compilation (compileCharter)
 *   - Model selection (resolveModel)
 *   - Fan-out spawning (spawnParallel)
 *   - Event bus (observability)
 */

import type { EventBus, SquadEvent } from '../runtime/event-bus.js';
import type { SquadConfig } from '../runtime/config.js';
import {
  DirectResponseHandler,
  type CoordinatorContext,
  type DirectResponseResult,
} from './direct-response.js';
import {
  matchRoute,
  compileRoutingRules,
  type CompiledRouter,
  type RoutingMatch,
} from '../config/routing.js';
import type { RoutingConfig as RuntimeRoutingConfig } from '../runtime/config.js';
import { spawnParallel, type AgentSpawnConfig, type SpawnResult, type FanOutDependencies } from './fan-out.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';
import {
  startAssignmentRecording,
  finishAssignmentRecording,
  type AdpRunRecorder,
} from '../adp/index.js';

const tracer = trace.getTracer('squad-sdk');

// --- Re-export CoordinatorContext for convenience ---
export type { CoordinatorContext } from './direct-response.js';

// --- Spawn Strategy ---

export type SpawnStrategy = 'direct' | 'single' | 'multi' | 'fallback';

// --- Coordinator Result ---

export interface CoordinatorResult {
  /** How the message was handled */
  strategy: SpawnStrategy;
  /** Direct response (if strategy is 'direct') */
  directResponse?: DirectResponseResult;
  /** Routing match info */
  routing?: RoutingMatch;
  /** Spawn results (if agents were spawned) */
  spawnResults?: SpawnResult[];
  /** Time taken to handle the message in ms */
  durationMs: number;
}

// --- Coordinator Options ---

export interface SquadCoordinatorOptions {
  /** Squad configuration */
  config: SquadConfig;
  /** Event bus for observability */
  eventBus?: EventBus;
  /** Fan-out dependencies (charter compiler, model resolver, session creator) */
  fanOutDeps?: FanOutDependencies;
  /** Custom direct-response handler */
  directHandler?: DirectResponseHandler;
  /** Custom compiled router (skips compilation from config) */
  compiledRouter?: CompiledRouter;
  /**
   * Record this assignment into ADP. Requires an `adp` block in
   * `.squad/config.json` and the token in the env var it names; without either,
   * nothing is constructed and behaviour is unchanged.
   */
  adp?: AdpAssignmentOptions;
  /**
   * Ceiling for each spawned agent's opening turn, in ms. Omitted means no
   * deadline (the historical behaviour).
   *
   * Lives here rather than being read off `SquadConfig` because the callers
   * that care about a bounded assignment — headless runners driving the SDK
   * path — synthesise a minimal config and would have nowhere to put it.
   */
  turnTimeoutMs?: number;
}

export interface AdpAssignmentOptions {
  /** Repo root holding `.squad/config.json`. */
  repoRoot: string;
  /** Squad's stable id for the assignment, e.g. `issue:42`. */
  externalRef: string;
  /** The intent the assignment is against, or the issue to read it from. */
  intentId?: string;
  issueNumber?: number;
  /** Recording failures land here — logged at warn, never fatal. */
  onError?: (error: Error, context: string) => void;
}

// --- Coordinator Class ---

/**
 * Main coordinator entry point.
 *
 * Pipeline:
 * 1. Direct response check (no-spawn fast path)
 * 2. Route analysis (message → routing rules → agent selection)
 * 3. Spawn strategy (single vs multi vs fallback)
 * 4. Fan-out spawn
 * 5. Collect results + emit events
 */
export class SquadCoordinator {
  private config: SquadConfig;
  private eventBus?: EventBus;
  private directHandler: DirectResponseHandler;
  private compiledRouter: CompiledRouter;
  private fanOutDeps?: FanOutDependencies;
  private adp?: AdpAssignmentOptions;
  private turnTimeoutMs?: number;
  private recorder?: AdpRunRecorder;
  /** Shared so two concurrent messages open one run, not two. */
  private recording?: Promise<AdpRunRecorder | undefined>;

  constructor(options: SquadCoordinatorOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus;
    this.fanOutDeps = options.fanOutDeps;
    this.adp = options.adp;
    this.turnTimeoutMs = options.turnTimeoutMs;
    this.directHandler = options.directHandler ?? new DirectResponseHandler();

    // Compile routing rules from config or use provided router
    if (options.compiledRouter) {
      this.compiledRouter = options.compiledRouter;
    } else {
      this.compiledRouter = this.compileRouter(this.config);
    }
  }

  /**
   * Main dispatch — handle an incoming user message.
   */
  async handleMessage(
    message: string,
    context: CoordinatorContext,
  ): Promise<CoordinatorResult> {
    const span = tracer.startSpan('squad.coordinator.handleMessage');
    span.setAttribute('message.length', message.length);
    try {
      const start = Date.now();

      // Before the first routing decision, so the run exists to hold it. The
      // recorder subscribes to the bus, and an event emitted before it did
      // would be missing from the trajectory with nothing to indicate it ever
      // happened.
      await this.ensureRecording();

      // Emit coordinator.route event
      await this.emit('coordinator:routing', context.sessionId, {
        phase: 'start',
        messageLength: message.length,
      });

      // --- Step 1: Direct response check ---
      if (this.directHandler.shouldHandleDirectly(message, this.config)) {
        const directResult = this.directHandler.handleDirect(message, context);

        await this.emit('coordinator:routing', context.sessionId, {
          phase: 'complete',
          strategy: 'direct',
          category: directResult.category,
        });

        span.setAttribute('routing.strategy', 'direct');
        return {
          strategy: 'direct',
          directResponse: directResult,
          durationMs: Date.now() - start,
        };
      }

      // --- Step 2: Route analysis ---
      const routing = matchRoute(message, this.compiledRouter);

      await this.emit('coordinator:routing', context.sessionId, {
        phase: 'routed',
        agents: routing.agents,
        confidence: routing.confidence,
        reason: routing.reason,
      });

      span.setAttribute('target.agents', routing.agents.join(','));
      span.setAttribute('routing.confidence', routing.confidence);

      // --- Step 3: Determine spawn strategy ---
      const strategy = this.determineStrategy(routing);
      span.setAttribute('routing.strategy', strategy);

      // --- Step 4: Spawn agents ---
      let spawnResults: SpawnResult[] | undefined;

      if (this.fanOutDeps && (strategy === 'single' || strategy === 'multi')) {
        const spawnConfigs = this.buildSpawnConfigs(routing, message, context);

        await this.emit('coordinator:routing', context.sessionId, {
          phase: 'spawning',
          strategy,
          agentCount: spawnConfigs.length,
        });

        // `spawnParallel` resolves only once every agent's turn has completed —
        // both backends resolve `sendMessage`/`sendAndWait` on turn completion,
        // not on dispatch. So by this line the fan-out is genuinely done, and a
        // caller does not need to sleep and hope.
        spawnResults = await spawnParallel(spawnConfigs, this.fanOutDeps);

        // Give each agent a terminal event. Nothing else emits one, so without
        // this an ADP session stays `active` until closing the run sweeps it,
        // and a UI has nothing to render "this agent finished" from. The
        // recorder's `session:destroyed` case also flushes that session, so the
        // agent's trajectory is durable at the moment it stops rather than at
        // the end of the assignment.
        for (const result of spawnResults) {
          await this.emit(
            'session:destroyed',
            result.sessionId,
            {
              agentName: result.agentName,
              reason: result.status === 'success' ? 'complete' : 'error',
            },
            result.agentName,
          );
        }

        // If all spawns failed in single mode, mark as fallback
        if (strategy === 'single' && spawnResults.every(r => r.status === 'failed')) {
          return {
            strategy: 'fallback',
            routing,
            spawnResults,
            durationMs: Date.now() - start,
          };
        }
      }

      // --- Step 5: Complete ---
      await this.emit('coordinator:routing', context.sessionId, {
        phase: 'complete',
        strategy,
        spawnCount: spawnResults?.length ?? 0,
        successCount: spawnResults?.filter(r => r.status === 'success').length ?? 0,
      });

      return {
        strategy,
        routing,
        spawnResults,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * The ADP recorder for this assignment, once one exists. `undefined` whenever
   * recording is not configured — which is the common case and not an error.
   */
  getRecorder(): AdpRunRecorder | undefined {
    return this.recorder;
  }

  /**
   * Finish the assignment: close the run against the commit it produced, or
   * abandon it when it produced none.
   *
   * Separate from `handleMessage` because the coordinator dispatches messages
   * and an assignment spans several of them — the caller is the only one that
   * knows the work is over and what sha came out of it. A no-op when nothing is
   * being recorded.
   */
  async finishAssignment(outcome: { finalGitSha?: string | null; reason?: string }): Promise<void> {
    await finishAssignmentRecording(this.recorder, outcome, this.adp?.onError);
    this.recorder = undefined;
    this.recording = undefined;
  }

  /**
   * Get the compiled router (for inspection / testing).
   */
  getRouter(): CompiledRouter {
    return this.compiledRouter;
  }

  /**
   * Get the direct response handler (for inspection / testing).
   */
  getDirectHandler(): DirectResponseHandler {
    return this.directHandler;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: SquadConfig): void {
    this.config = config;
    this.compiledRouter = this.compileRouter(config);
  }

  // --- Private helpers ---

  /**
   * Open the run on the first message of an assignment, once.
   *
   * Needs a bus: the trajectory is assembled from what the bus emits, and a
   * recorder with nothing to subscribe to would open a run and then attest to
   * an empty one — worse than not recording, because it looks like a record.
   */
  private async ensureRecording(): Promise<void> {
    if (!this.adp || !this.eventBus || this.recorder) return;
    if (!this.recording) {
      this.recording = startAssignmentRecording({
        repoRoot: this.adp.repoRoot,
        bus: this.eventBus,
        externalRef: this.adp.externalRef,
        intentId: this.adp.intentId,
        issueNumber: this.adp.issueNumber,
        onError: this.adp.onError,
      });
    }
    this.recorder = await this.recording;
  }

  private determineStrategy(routing: RoutingMatch): SpawnStrategy {
    if (routing.agents.length === 0) return 'fallback';
    if (routing.agents.length === 1) return 'single';
    return 'multi';
  }

  private buildSpawnConfigs(
    routing: RoutingMatch,
    message: string,
    context: CoordinatorContext,
  ): AgentSpawnConfig[] {
    return routing.agents.map((agentName) => ({
      agentName: agentName.replace(/^@/, ''),
      task: message,
      priority: routing.confidence === 'high' ? 'normal' : 'low',
      context: context.metadata ? JSON.stringify(context.metadata) : undefined,
      ...(this.turnTimeoutMs === undefined ? {} : { timeoutMs: this.turnTimeoutMs }),
    }));
  }

  private compileRouter(config: SquadConfig): CompiledRouter {
    // Convert config routing rules → runtime routing rules for the compiler
    const runtimeRules = (config.routing?.rules ?? []).map((rule: any) => ({
      workType: rule.workType ?? rule.pattern ?? 'unknown',
      agents: rule.agents,
      examples: rule.examples as string[] | undefined,
      confidence: rule.confidence as 'high' | 'medium' | 'low' | undefined,
    }));

    const routingConfig: RuntimeRoutingConfig = {
      rules: runtimeRules,
      governance: (config.routing as any)?.governance,
    };

    return compileRoutingRules(routingConfig);
  }

  private async emit(
    type: string,
    sessionId: string | undefined,
    payload: Record<string, unknown>,
    agentName?: string,
  ): Promise<void> {
    if (!this.eventBus) return;
    await this.eventBus.emit({
      type: type as SquadEvent['type'],
      sessionId,
      ...(agentName === undefined ? {} : { agentName }),
      payload,
      timestamp: new Date(),
    });
  }
}
