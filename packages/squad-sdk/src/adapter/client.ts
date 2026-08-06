/**
 * Squad SDK Client Adapter
 *
 * Wraps GeminiClient to provide the stable SquadClient public API with
 * connection lifecycle management and OTel tracing.
 *
 * @module adapter/client
 */

import type { SquadBackend, SquadProvider } from './backend.js';
import { createBackend, resolveProvider } from './backend-factory.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';
import { recordSessionCreated, recordSessionClosed, recordSessionError, recordTokenUsage } from '../runtime/otel-metrics.js';
import { estimateCost } from '../config/models.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { SessionModelUsagePayload } from '../runtime/event-payloads.js';
import type { UsageEvent } from '../runtime/streaming.js';
import type {
  SquadSessionConfig,
  SquadSession,
  SquadSessionEvent,
  SquadSessionMetadata,
  SquadGetAuthStatusResponse,
  SquadGetStatusResponse,
  SquadModelInfo,
  SquadMessageOptions,
  SquadClientEventType,
  SquadClientEvent,
  SquadClientEventHandler,
} from './types.js';

const tracer = trace.getTracer('squad-sdk');

/**
 * Connection state for SquadClient.
 */
export type SquadConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error';

/**
 * Options for creating a SquadClient.
 */
export interface SquadClientOptions {
  /**
   * Backend to run on. When omitted, resolved from `.squad/config.json`,
   * then `SQUAD_PROVIDER`, then the default. See `resolveProvider`.
   */
  provider?: SquadProvider;

  /**
   * Gemini API key.
   * Falls back to process.env.GEMINI_API_KEY when not provided.
   *
   * @deprecated Prefer `provider: 'gemini'`. Passing a key still works and
   * still implies the Gemini backend.
   */
  geminiApiKey?: string;

  /**
   * Anthropic API key. Optional — when absent the Agent SDK falls back to
   * the credentials the local `claude` CLI is signed in with, which is the
   * normal path.
   */
  anthropicApiKey?: string;

  /** `.squad/` directory, for the persisted provider preference. */
  squadDir?: string;

  /**
   * Automatically connect when creating a session.
   * @default true
   */
  autoStart?: boolean;

  /**
   * Optional EventBus for telemetry auto-wiring.
   * When provided, session `usage` events are automatically forwarded
   * to the EventBus, enabling CostTracker and OTel integration.
   */
  eventBus?: EventBus;
}

/**
 * SquadClient — lifecycle wrapper and tracing shim over a {@link SquadBackend}.
 *
 * @example
 * ```typescript
 * const client = new SquadClient();
 * await client.connect();
 *
 * const session = await client.createSession({ model: 'gemini-pro-latest' });
 * await client.sendMessage(session, { prompt: 'Hello!' });
 *
 * await client.disconnect();
 * ```
 */
export class SquadClient {
  /**
   * Constructed on first `connect()`, not in the constructor.
   *
   * Selecting a backend can require a dynamic import, which a constructor
   * cannot await. `createSession()` already calls `connect()` first, so the
   * laziness is invisible to callers.
   */
  private backend: SquadBackend | null = null;
  /** Which backend is in use — for error messages and status fallbacks. */
  private provider: SquadProvider;
  private state: SquadConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private readonly autoStart: boolean;
  private readonly eventBus: EventBus | undefined;
  private readonly options: SquadClientOptions;

  constructor(options: SquadClientOptions = {}) {
    this.options = options;
    // Resolved eagerly so error messages and getStatus() can name the backend
    // before anything has connected. Constructing it is what waits.
    this.provider = resolveProvider(options);
    this.autoStart = options.autoStart ?? true;
    this.eventBus = options.eventBus;
  }

  /** The backend, once connected. Throws if used before `connect()`. */
  private get connected(): SquadBackend {
    if (!this.backend) {
      throw new Error('Client not connected. Call connect() first.');
    }
    return this.backend;
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  getState(): SquadConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.state === 'connected') return;

    if (this.state === 'connecting' && this.connectPromise) {
      return this.connectPromise;
    }

    const span = tracer.startSpan('squad.client.connect');
    this.state = 'connecting';

    this.connectPromise = (async () => {
      const startTime = Date.now();
      try {
        if (!this.backend) {
          const selected = await createBackend(this.options);
          this.provider = selected.provider;
          this.backend = selected.backend;
        }
        await this.backend.start();
        this.state = 'connected';
        span.setAttribute('connection.duration_ms', Date.now() - startTime);
      } catch (error) {
        this.state = 'error';
        const wrapped = new Error(
          `Failed to connect to ${this.provider} backend: ${error instanceof Error ? error.message : String(error)}`,
        );
        span.setStatus({ code: SpanStatusCode.ERROR, message: wrapped.message });
        span.recordException(wrapped);
        throw wrapped;
      } finally {
        this.connectPromise = null;
        span.end();
      }
    })();

    return this.connectPromise;
  }

  async disconnect(): Promise<Error[]> {
    const span = tracer.startSpan('squad.client.disconnect');
    try {
      const errors = await this.connected.stop();
      this.state = 'disconnected';
      return errors;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async forceDisconnect(): Promise<void> {
    await this.connected.stop();
    this.state = 'disconnected';
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    const span = tracer.startSpan('squad.session.create');
    try {
      if (!this.isConnected() && this.autoStart) {
        await this.connect();
      }
      if (!this.isConnected()) {
        throw new Error('Client not connected. Call connect() first.');
      }

      const session = this.connected.createSession(config);
      if (session.sessionId) {
        span.setAttribute('session.id', session.sessionId);
      }
      recordSessionCreated();

      // Auto-forward usage and tool events to EventBus when configured
      if (this.eventBus) {
        const bus = this.eventBus;
        const sid = session.sessionId;
        // Carried on every forwarded event so consumers can attribute work to
        // an agent rather than to a session id. Without it CostTracker files
        // every turn under "unknown", which makes per-agent spend — the thing
        // the cost table exists for — unreadable.
        const agentName = config.agentName;
        session.on('usage', (event: SquadSessionEvent) => {
          const inputTokens = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
          const outputTokens = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
          const model = typeof event['model'] === 'string' ? event['model'] : 'unknown';
          // A backend that knows what the turn actually cost is always more
          // accurate than a catalog estimate: it accounts for cache reads and
          // writes, and it reports the model that truly served the turn
          // (which may be a dated id the catalog has no entry for).
          const reported = event['costUsd'];
          const cost =
            typeof reported === 'number' && Number.isFinite(reported)
              ? reported
              : estimateCost(model, inputTokens, outputTokens);
          // `session:model_usage`, not `session:message`. These are the real
          // token counts a backend reported for one model invocation, and
          // filing them as a message meant the only way to tell what a turn
          // cost from something an agent said was to sniff the payload for
          // `inputTokens` — which is why they never reached ADP as model calls.
          // CostTracker consumes both, so nothing that was counting stops.
          const readNum = (key: string): number | undefined =>
            typeof event[key] === 'number' && Number.isFinite(event[key] as number)
              ? (event[key] as number)
              : undefined;
          void bus.emit({
            type: 'session:model_usage',
            sessionId: sid,
            agentName,
            payload: {
              inputTokens,
              outputTokens,
              model,
              estimatedCost: cost,
              agentName,
              // Forwarded rather than collapsed: cache reads and writes are
              // priced differently, per-model entries are what make
              // attribution possible when the backend bills more than one,
              // and timings are the only latency signal there is.
              cacheReadInputTokens: readNum('cacheReadInputTokens'),
              cacheCreationInputTokens: readNum('cacheCreationInputTokens'),
              models: Array.isArray(event['models'])
                ? (event['models'] as SessionModelUsagePayload['models'])
                : undefined,
              durationMs: readNum('durationMs'),
              ttftMs: readNum('ttftMs'),
              numTurns: readNum('numTurns'),
            },
            timestamp: new Date(),
          });
        });

        // Tool executions reach the bus the same way, and for the same reason
        // they did not before: the backend emits them as session events and
        // nothing forwarded them, so `session:tool_call` — a type the recorder
        // has always mapped — had no producer anywhere in the SDK. Tools ran,
        // files changed, and the trajectory recorded none of it.
        //
        // Paired on `toolCallId` and emitted once, at the *result*: the bus
        // payload carries the outcome, and a tool that is denied has to arrive
        // as `rejected` rather than as a failure. Emitting at the call as well
        // would double every tool in the count.
        // Held from the call to its result: the arguments (the result event
        // carries none) and the start time (nothing else measures a tool).
        const pendingTools = new Map<string, { args: Record<string, unknown>; startedAt: number }>();

        // The tool-round budget, enforced here rather than in each backend.
        //
        // This is the only place that sees every tool result from every client,
        // so it is the only place a budget can mean the same thing across
        // vendors. It used to live inside the Gemini client — ten rounds, throw
        // on exceeding — with no Anthropic equivalent, which made any
        // cross-vendor comparison on a task longer than ten rounds a
        // measurement of the ceiling rather than of the models.
        //
        // Stopping is a milestone and an abort, never an error: a variant that
        // spent its budget is a legitimate, recordable outcome.
        let toolRounds = 0;
        let budgetSpent = false;
        const budget = config.maxToolRounds;
        session.on('tool_call', (event: SquadSessionEvent) => {
          const id = String(event['toolCallId'] ?? '');
          pendingTools.set(id, {
            args: (event['arguments'] as Record<string, unknown>) ?? {},
            startedAt: Date.now(),
          });
        });
        session.on('tool_result', (event: SquadSessionEvent) => {
          const id = String(event['toolCallId'] ?? '');
          const pending = pendingTools.get(id);
          pendingTools.delete(id);
          const result = event['result'] as { resultType?: string; error?: unknown } | undefined;
          const resultType =
            result?.resultType ?? (result?.error !== undefined ? 'failure' : 'success');
          void bus.emit({
            type: 'session:tool_call',
            sessionId: sid,
            agentName,
            payload: {
              toolName: typeof event['toolName'] === 'string' ? event['toolName'] : 'unknown',
              toolArgs: pending?.args ?? {},
              resultType,
              // Measured here rather than in each backend: this is the one
              // place that sees both ends of every tool call, whichever
              // client raised it.
              durationMs: pending ? Date.now() - pending.startedAt : undefined,
            },
            timestamp: new Date(),
          });

          toolRounds += 1;
          if (budget !== undefined && !budgetSpent && toolRounds >= budget) {
            budgetSpent = true;
            void bus.emit({
              type: 'agent:milestone',
              sessionId: sid,
              agentName,
              payload: { event: 'budget.exhausted', agentName, rounds: toolRounds, budget },
              timestamp: new Date(),
            });
            // Cooperative, like every other stop in the system. A backend that
            // ignores it is caught by the variant deadline above it.
            void session.abort?.();
          }
        });
      }

      return session;
    } catch (err) {
      recordSessionError();
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const span = tracer.startSpan('squad.session.delete');
    span.setAttribute('session.id', sessionId);
    try {
      recordSessionClosed();
    } finally {
      span.end();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const span = tracer.startSpan('squad.session.close');
    span.setAttribute('session.id', sessionId);
    try {
      await this.deleteSession(sessionId);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async listSessions(): Promise<SquadSessionMetadata[]> {
    return (await this.connected.listSessions?.()) ?? [];
  }

  async getLastSessionId(): Promise<string | undefined> {
    return this.connected.getLastSessionId?.();
  }

  // ---------------------------------------------------------------------------
  // Auth and status
  // ---------------------------------------------------------------------------

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    return this.connected.getAuthStatus();
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return (await this.backend?.getStatus?.()) ?? { version: this.provider, protocolVersion: 1 };
  }

  async ping(msg?: string): Promise<{ message: string; timestamp: number; protocolVersion: number }> {
    return { message: msg ?? 'pong', timestamp: Date.now(), protocolVersion: 1 };
  }

  async listModels(): Promise<SquadModelInfo[]> {
    return (await this.backend?.listModels?.()) ?? [];
  }

  // ---------------------------------------------------------------------------
  // sendMessage — with OTel tracing
  // ---------------------------------------------------------------------------

  async sendMessage(session: SquadSession, options: SquadMessageOptions): Promise<void> {
    const messageSpan = tracer.startSpan('squad.session.message');
    messageSpan.setAttribute('session.id', session.sessionId);
    messageSpan.setAttribute('prompt.length', options.prompt.length);

    const streamSpan = tracer.startSpan('squad.session.stream');
    streamSpan.setAttribute('session.id', session.sessionId);

    const startMs = Date.now();
    let firstToken = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let model = 'unknown';

    const listener = (event: SquadSessionEvent) => {
      if (event.type === 'message_delta' && !firstToken) {
        firstToken = true;
        streamSpan.addEvent('first_token');
      }
      if (event.type === 'usage') {
        inputTokens = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
        outputTokens = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
        model = typeof event['model'] === 'string' ? event['model'] : 'unknown';
      }
    };

    session.on('message_delta', listener);
    session.on('usage', listener);

    try {
      await session.sendMessage(options);

      const durationMs = Date.now() - startMs;
      streamSpan.addEvent('last_token');
      streamSpan.setAttribute('tokens.input', inputTokens);
      streamSpan.setAttribute('tokens.output', outputTokens);
      streamSpan.setAttribute('duration_ms', durationMs);

      if (inputTokens > 0 || outputTokens > 0) {
        const usageEvent: UsageEvent = {
          type: 'usage',
          sessionId: session.sessionId,
          model,
          inputTokens,
          outputTokens,
          estimatedCost: estimateCost(model, inputTokens, outputTokens),
          timestamp: new Date(),
        };
        recordTokenUsage(usageEvent);
      }
    } catch (err) {
      streamSpan.addEvent('stream_error');
      streamSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      streamSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      messageSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      messageSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      streamSpan.end();
      messageSpan.end();
      try {
        session.off('message_delta', listener);
        session.off('usage', listener);
      } catch {
        // session may not support off — ignore
      }
    }
  }

  async sendAndWait(session: SquadSession, options: SquadMessageOptions, timeout?: number): Promise<unknown> {
    const span = tracer.startSpan('squad.session.sendAndWait');
    span.setAttribute('session.id', session.sessionId);
    span.setAttribute('prompt.length', options.prompt.length);

    let inputTokens = 0;
    let outputTokens = 0;
    let model = 'unknown';

    const usageListener = (event: SquadSessionEvent) => {
      if (event.type === 'usage') {
        inputTokens = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
        outputTokens = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
        model = typeof event['model'] === 'string' ? event['model'] : 'unknown';
      }
    };

    session.on('usage', usageListener);

    try {
      if (!session.sendAndWait) {
        throw new Error('Session does not support sendAndWait()');
      }
      const result = await session.sendAndWait(options, timeout);

      span.setAttribute('tokens.input', inputTokens);
      span.setAttribute('tokens.output', outputTokens);

      if (inputTokens > 0 || outputTokens > 0) {
        const usageEvent: UsageEvent = {
          type: 'usage',
          sessionId: session.sessionId,
          model,
          inputTokens,
          outputTokens,
          estimatedCost: estimateCost(model, inputTokens, outputTokens),
          timestamp: new Date(),
        };
        recordTokenUsage(usageEvent);
      }

      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
      try {
        session.off('usage', usageListener);
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Client-level lifecycle events
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to client-level lifecycle events, returning an unsubscribe fn.
   *
   * Backends without a server-push channel omit `on`, in which case this
   * returns a no-op unsubscribe — callers never have to null-check.
   */
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void,
  ): () => void {
    if (!this.backend?.on) return () => {};
    // Overloaded: either (eventType, handler) or (handler) for all events.
    if (typeof eventTypeOrHandler === 'function') {
      return this.backend.on('session.created', eventTypeOrHandler);
    }
    if (!handler) return () => {};
    return this.backend.on(eventTypeOrHandler, handler);
  }
}
