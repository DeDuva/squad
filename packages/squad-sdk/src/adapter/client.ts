/**
 * Squad SDK Client Adapter
 *
 * Provider-agnostic client that delegates all LLM operations to an
 * ISquadClientBackend. The backend is selected at construction time based
 * on the `provider` option (defaults to 'copilot' for backward compat).
 *
 * OTel tracing, event bus auto-wiring, and usage recording remain here
 * (centralized) regardless of which backend is active.
 *
 * Supported providers:
 *   copilot   — GitHub Copilot via @github/copilot-sdk (default)
 *   anthropic — Anthropic Claude via @anthropic-ai/sdk
 *   gemini    — Google Gemini via @google/genai
 *
 * @module adapter/client
 */

import { trace, SpanStatusCode } from '../runtime/otel-api.js';
import { recordSessionCreated, recordSessionClosed, recordSessionError, recordTokenUsage } from '../runtime/otel-metrics.js';
import { estimateCost } from '../config/models.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { UsageEvent } from '../runtime/streaming.js';
import type {
  SquadSessionConfig,
  SquadSession,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadSessionEventType,
  SquadSessionMetadata,
  SquadGetAuthStatusResponse,
  SquadGetStatusResponse,
  SquadModelInfo,
  SquadMessageOptions,
  SquadClientEventType,
  SquadClientEvent,
  SquadClientEventHandler,
} from './types.js';
import type { ISquadClientBackend, SquadProviderType } from './providers/base.js';
import { createBackend } from './providers/factory.js';

export { type SquadProviderType };

const tracer = trace.getTracer('squad-sdk');

/**
 * Connection state for SquadClient.
 */
export type SquadConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Options for creating a SquadClient.
 */
export interface SquadClientOptions {
  // -------------------------------------------------------------------------
  // Provider selection (NEW)
  // -------------------------------------------------------------------------

  /**
   * Which LLM provider to use.
   * @default 'copilot'
   */
  provider?: SquadProviderType;

  /**
   * Anthropic-specific options. Only used when provider === 'anthropic'.
   */
  anthropic?: {
    /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Default model. Defaults to 'claude-sonnet-4-5'. */
    model?: string;
  };

  /**
   * Gemini-specific options. Only used when provider === 'gemini'.
   */
  gemini?: {
    /** Gemini API key. Defaults to GEMINI_API_KEY env var. */
    apiKey?: string;
    /** Default model. Defaults to 'gemini-2.5-flash'. */
    model?: string;
  };

  // -------------------------------------------------------------------------
  // Copilot-specific options (ignored for Anthropic / Gemini providers)
  // -------------------------------------------------------------------------

  /**
   * Path to the Copilot CLI executable.
   * Defaults to bundled CLI from @github/copilot package.
   */
  cliPath?: string;

  /** Additional arguments to pass to the CLI process. */
  cliArgs?: string[];

  /**
   * Working directory for the CLI process.
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Port to bind the CLI server (TCP mode).
   * Set to 0 for random port, or undefined to use stdio mode.
   */
  port?: number;

  /**
   * Use stdio transport instead of TCP.
   * @default true
   */
  useStdio?: boolean;

  /**
   * URL of an external CLI server to connect to.
   * Mutually exclusive with useStdio and cliPath.
   */
  cliUrl?: string;

  /**
   * Log level for the CLI process.
   * @default "debug"
   */
  logLevel?: 'error' | 'warning' | 'info' | 'debug' | 'all' | 'none';

  /**
   * Automatically start the connection when creating a session.
   * @default true
   */
  autoStart?: boolean;

  /**
   * Automatically reconnect on transient failures.
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Optional EventBus for telemetry auto-wiring.
   * When provided, session `usage` events are automatically forwarded
   * to the EventBus, enabling CostTracker and OTel integration.
   */
  eventBus?: EventBus;

  /**
   * Environment variables to pass to the CLI process.
   * @default process.env
   */
  env?: Record<string, string>;

  /**
   * GitHub token for authentication.
   * If not provided, uses logged-in user credentials.
   */
  githubToken?: string;

  /**
   * Use logged-in user credentials for authentication.
   * @default true (false if githubToken is provided)
   */
  useLoggedInUser?: boolean;

  /**
   * Maximum number of reconnection attempts before giving up.
   * @default 3
   */
  maxReconnectAttempts?: number;

  /**
   * Initial delay in milliseconds before first reconnection attempt.
   * Subsequent attempts use exponential backoff.
   * @default 1000
   */
  reconnectDelayMs?: number;
}

/**
 * Provider-agnostic Squad client.
 *
 * Delegates all LLM operations to the selected backend while keeping
 * OTel tracing, usage recording, and EventBus wiring centralized.
 *
 * @example Anthropic
 * ```typescript
 * const client = new SquadClient({ provider: 'anthropic' });
 * await client.connect();
 * const session = await client.createSession({ model: 'claude-sonnet-4-5' });
 * ```
 *
 * @example Gemini
 * ```typescript
 * const client = new SquadClient({ provider: 'gemini' });
 * await client.connect();
 * const session = await client.createSession({ model: 'gemini-2.5-flash' });
 * ```
 *
 * @example Copilot (default — backward compatible)
 * ```typescript
 * const client = new SquadClient();
 * await client.connect();
 * const session = await client.createSession({ model: 'claude-sonnet-4.5' });
 * ```
 */
export class SquadClient {
  private backend: ISquadClientBackend;
  private state: SquadConnectionState = 'disconnected';
  private readonly eventBus?: EventBus;
  private readonly autoStart: boolean;

  constructor(options: SquadClientOptions = {}) {
    this.eventBus = options.eventBus;
    this.autoStart = options.autoStart ?? true;
    this.backend = createBackend(options.provider, options);
  }

  getState(): SquadConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.backend.isConnected();
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const span = tracer.startSpan('squad.client.connect');
    this.state = 'connecting';
    try {
      await this.backend.connect();
      this.state = 'connected';
      span.setAttribute('connection.provider', String((this.backend as any).constructor?.name ?? 'unknown'));
    } catch (err) {
      this.state = 'error';
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async disconnect(): Promise<Error[]> {
    const span = tracer.startSpan('squad.client.disconnect');
    try {
      const errors = await this.backend.disconnect();
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
    await this.backend.forceDisconnect();
    this.state = 'disconnected';
  }

  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    const span = tracer.startSpan('squad.session.create');
    try {
      if (!this.isConnected()) {
        if (!this.autoStart) throw new Error('Client not connected');
        await this.connect();
      }
      const session = await this.backend.createSession(config);
      if (session.sessionId) span.setAttribute('session.id', session.sessionId);
      recordSessionCreated();

      // Auto-forward usage events to EventBus when one is configured
      if (this.eventBus) {
        const bus = this.eventBus;
        const sid = session.sessionId;
        session.on('usage', (event: SquadSessionEvent) => {
          const inputTokens = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
          const outputTokens = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
          const model = typeof event['model'] === 'string' ? event['model'] : 'unknown';
          const cost = estimateCost(model, inputTokens, outputTokens);
          void bus.emit({
            type: 'session:message',
            sessionId: sid,
            payload: { inputTokens, outputTokens, model, estimatedCost: cost },
            timestamp: new Date(),
          });
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

  async resumeSession(sessionId: string, config: SquadSessionConfig = {}): Promise<SquadSession> {
    const span = tracer.startSpan('squad.session.resume');
    span.setAttribute('session.id', sessionId);
    try {
      if (!this.isConnected()) {
        if (!this.autoStart) throw new Error('Client not connected');
        await this.connect();
      }
      return await this.backend.resumeSession(sessionId, config);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async listSessions(): Promise<SquadSessionMetadata[]> {
    const span = tracer.startSpan('squad.session.list');
    try {
      if (!this.isConnected()) throw new Error('Client not connected');
      const result = await this.backend.listSessions();
      span.setAttribute('sessions.count', result.length);
      return result;
    } catch (err) {
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
      if (!this.isConnected()) throw new Error('Client not connected');
      await this.backend.deleteSession(sessionId);
      recordSessionClosed();
    } catch (err) {
      recordSessionError();
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async getLastSessionId(): Promise<string | undefined> {
    if (!this.isConnected()) throw new Error('Client not connected');
    return this.backend.getLastSessionId();
  }

  async ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }> {
    if (!this.isConnected()) throw new Error('Client not connected');
    return this.backend.ping(message);
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    if (!this.isConnected()) throw new Error('Client not connected');
    return this.backend.getStatus();
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    if (!this.isConnected()) throw new Error('Client not connected');
    return this.backend.getAuthStatus();
  }

  async listModels(): Promise<SquadModelInfo[]> {
    if (!this.isConnected()) throw new Error('Client not connected');
    return this.backend.listModels();
  }

  /**
   * Send a message to a session, wrapped with OTel tracing.
   */
  async sendMessage(session: SquadSession, options: SquadMessageOptions): Promise<void> {
    const messageSpan = tracer.startSpan('squad.session.message');
    messageSpan.setAttribute('session.id', session.sessionId);
    messageSpan.setAttribute('prompt.length', options.prompt.length);
    messageSpan.setAttribute('streaming', true);

    const streamSpan = tracer.startSpan('squad.session.stream');
    streamSpan.setAttribute('session.id', session.sessionId);

    const messageStartMs = Date.now();
    let firstTokenRecorded = false;
    let outputTokens = 0;
    let inputTokens = 0;
    let model = 'unknown';

    const origOn = session.on.bind(session);
    const streamListener = (event: SquadSessionEvent) => {
      if (event.type === 'message_delta' && !firstTokenRecorded) {
        firstTokenRecorded = true;
        streamSpan.addEvent('first_token');
      }
      if (event.type === 'usage') {
        inputTokens = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
        outputTokens = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
        model = typeof event['model'] === 'string' ? event['model'] : 'unknown';
      }
    };

    origOn('message_delta', streamListener);
    origOn('usage', streamListener);

    try {
      await session.sendMessage(options);

      const durationMs = Date.now() - messageStartMs;
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
        session.off('message_delta', streamListener);
        session.off('usage', streamListener);
      } catch { /* session may not support off */ }
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
      if (!session.sendAndWait) throw new Error('Session does not support sendAndWait()');
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
      try { session.off('usage', usageListener); } catch { /* ignore */ }
    }
  }

  on<K extends SquadClientEventType>(eventType: K, handler: (event: SquadClientEvent & { type: K }) => void): () => void;
  on(handler: SquadClientEventHandler): () => void;
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void
  ): () => void {
    if (typeof eventTypeOrHandler === 'string' && handler) {
      return this.backend.on(eventTypeOrHandler, handler);
    } else {
      return this.backend.on(eventTypeOrHandler as SquadClientEventHandler);
    }
  }
}
