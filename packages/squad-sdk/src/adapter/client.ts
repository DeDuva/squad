/**
 * Squad SDK Client Adapter
 *
 * Wraps GeminiClient to provide the stable SquadClient public API with
 * connection lifecycle management and OTel tracing.
 *
 * @module adapter/client
 */

import { GeminiClient } from './gemini-client.js';
import type { SquadBackend, SquadProvider } from './backend.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';
import { recordSessionCreated, recordSessionClosed, recordSessionError, recordTokenUsage } from '../runtime/otel-metrics.js';
import { estimateCost } from '../config/models.js';
import type { EventBus } from '../runtime/event-bus.js';
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
   * Gemini API key.
   * Falls back to process.env.GEMINI_API_KEY when not provided.
   */
  geminiApiKey?: string;

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
  private backend: SquadBackend;
  /** Which backend is in use — for error messages and status fallbacks. */
  private readonly provider: SquadProvider;
  private state: SquadConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private readonly autoStart: boolean;
  private readonly eventBus: EventBus | undefined;

  constructor(options: SquadClientOptions = {}) {
    const apiKey = options.geminiApiKey ?? process.env['GEMINI_API_KEY'] ?? '';
    this.provider = 'gemini';
    this.backend = new GeminiClient(apiKey);
    this.autoStart = options.autoStart ?? true;
    this.eventBus = options.eventBus;
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
      const errors = await this.backend.stop();
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
    await this.backend.stop();
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

      const session = this.backend.createSession(config);
      if (session.sessionId) {
        span.setAttribute('session.id', session.sessionId);
      }
      recordSessionCreated();

      // Auto-forward usage events to EventBus when configured
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
    return (await this.backend.listSessions?.()) ?? [];
  }

  async getLastSessionId(): Promise<string | undefined> {
    return this.backend.getLastSessionId?.();
  }

  // ---------------------------------------------------------------------------
  // Auth and status
  // ---------------------------------------------------------------------------

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    return this.backend.getAuthStatus();
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return (await this.backend.getStatus?.()) ?? { version: this.provider, protocolVersion: 1 };
  }

  async ping(msg?: string): Promise<{ message: string; timestamp: number; protocolVersion: number }> {
    return { message: msg ?? 'pong', timestamp: Date.now(), protocolVersion: 1 };
  }

  async listModels(): Promise<SquadModelInfo[]> {
    return (await this.backend.listModels?.()) ?? [];
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
    if (!this.backend.on) return () => {};
    // Overloaded: either (eventType, handler) or (handler) for all events.
    if (typeof eventTypeOrHandler === 'function') {
      return this.backend.on('session.created', eventTypeOrHandler);
    }
    if (!handler) return () => {};
    return this.backend.on(eventTypeOrHandler, handler);
  }
}
