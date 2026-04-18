/**
 * Anthropic Provider Backend
 *
 * Implements ISquadClientBackend using @anthropic-ai/sdk (direct API calls,
 * no intermediate process). Each SquadSession maintains its own conversation
 * history so multi-turn interactions work naturally.
 *
 * Requires: @anthropic-ai/sdk (listed as optionalDependency)
 * Auth: ANTHROPIC_API_KEY environment variable or options.anthropic.apiKey
 *
 * Model tiers:
 *   lightweight → claude-haiku-4-5
 *   standard    → claude-sonnet-4-5  (default)
 *   full        → claude-opus-4-5
 *
 * @module adapter/providers/anthropic
 */

import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionMetadata,
  SquadGetStatusResponse,
  SquadGetAuthStatusResponse,
  SquadModelInfo,
  SquadClientEventType,
  SquadClientEvent,
  SquadClientEventHandler,
  SquadSessionEvent,
  SquadSessionEventType,
  SquadSessionEventHandler,
  SquadMessageOptions,
} from '../types.js';
import type { ISquadClientBackend } from './base.js';
import { UnsupportedOperationError } from './base.js';
import type { SquadClientOptions } from '../client.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Lazy SDK import — only loads @anthropic-ai/sdk when provider is in use
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Anthropic: any = null;

async function getAnthropicSDK(): Promise<any> {
  if (_Anthropic) return _Anthropic;
  try {
    const mod = await import('@anthropic-ai/sdk');
    _Anthropic = mod.default ?? mod;
    return _Anthropic;
  } catch {
    throw new Error(
      'The Anthropic provider requires @anthropic-ai/sdk. ' +
      'Install it with: npm install @anthropic-ai/sdk'
    );
  }
}

// ---------------------------------------------------------------------------
// Message history types (mirrors Anthropic SDK MessageParam)
// ---------------------------------------------------------------------------

interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// AnthropicSession
// ---------------------------------------------------------------------------

/**
 * A stateful conversation session backed by the Anthropic Messages API.
 *
 * Maintains full message history so multi-turn conversations work correctly.
 * Emits Squad-standard events during streaming:
 *   message_delta  — { delta: string }         text chunk received
 *   usage          — { inputTokens, outputTokens, model }
 *   idle           — stream complete, session ready for next message
 *   error          — { error: string }          non-fatal stream error
 */
export class AnthropicSession implements SquadSession {
  readonly sessionId: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly model: string;
  private readonly systemPrompt: string;
  private history: MessageParam[] = [];
  private listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private currentAbortController: AbortController | null = null;
  private closed = false;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    model: string,
    systemMessage?: SquadSessionConfig['systemMessage'],
  ) {
    this.sessionId = randomUUID();
    this.client = client;
    this.model = model;
    this.systemPrompt = systemMessage?.mode === 'replace'
      ? systemMessage.content
      : (systemMessage?.content ?? '');
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  private emit(event: SquadSessionEvent): void {
    for (const handler of this.listeners.get(event.type) ?? []) {
      try { handler(event); } catch { /* isolate handler errors */ }
    }
  }

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    // Append user message to history
    this.history.push({ role: 'user', content: options.prompt });

    let accumulated = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const Anthropic = await getAnthropicSDK();
      const anthropicClient = this.client;

      const stream = await anthropicClient.messages.stream(
        {
          model: this.model,
          max_tokens: 8192,
          system: this.systemPrompt || undefined,
          messages: this.history.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal }
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const chunk: string = event.delta.text ?? '';
          if (chunk) {
            accumulated += chunk;
            this.emit({ type: 'message_delta', delta: chunk });
          }
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? 0;
        } else if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0;
        }
      }

      // Append assistant reply to history
      if (accumulated) {
        this.history.push({ role: 'assistant', content: accumulated });
      }

      // Emit usage summary
      this.emit({
        type: 'usage',
        inputTokens,
        outputTokens,
        model: this.model,
      });

      this.emit({ type: 'idle' });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        this.emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    } finally {
      this.currentAbortController = null;
    }
  }

  async sendAndWait(options: SquadMessageOptions, _timeout?: number): Promise<unknown> {
    if (this.closed) throw new Error('Session is closed');

    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    this.history.push({ role: 'user', content: options.prompt });

    try {
      const Anthropic = await getAnthropicSDK();
      const stream = await this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 8192,
          system: this.systemPrompt || undefined,
          messages: this.history.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal }
      );

      const message = await stream.finalMessage();
      const text = message.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');

      if (text) this.history.push({ role: 'assistant', content: text });

      this.emit({
        type: 'usage',
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        model: this.model,
      });
      this.emit({ type: 'idle' });

      return text;
    } finally {
      this.currentAbortController = null;
    }
  }

  async abort(): Promise<void> {
    this.currentAbortController?.abort();
  }

  async getMessages(): Promise<unknown[]> {
    return [...this.history];
  }

  async close(): Promise<void> {
    this.currentAbortController?.abort();
    this.history = [];
    this.listeners.clear();
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// AnthropicBackend
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS: SquadModelInfo[] = [
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } },
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } },
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 200000 } },
  },
];

/**
 * ISquadClientBackend implementation using the Anthropic Claude API directly.
 *
 * No subprocess required — connects directly to api.anthropic.com.
 * Stateless by nature; session history is maintained in-memory per AnthropicSession.
 */
export class AnthropicBackend implements ISquadClientBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private anthropic: any = null;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: SquadClientOptions = {}) {
    this.apiKey = options.anthropic?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this.defaultModel = options.anthropic?.model ?? 'claude-sonnet-4-5';
  }

  isConnected(): boolean {
    // REST providers are always "connected" — no persistent process
    return true;
  }

  async connect(): Promise<void> {
    const Anthropic = await getAnthropicSDK();
    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key required. Set ANTHROPIC_API_KEY environment variable ' +
        'or pass anthropic.apiKey in SquadClientOptions.'
      );
    }
    this.anthropic = new Anthropic({ apiKey: this.apiKey });
  }

  async disconnect(): Promise<Error[]> {
    this.anthropic = null;
    return [];
  }

  async forceDisconnect(): Promise<void> {
    this.anthropic = null;
  }

  private ensureClient(): void {
    if (!this.anthropic) {
      throw new Error('AnthropicBackend not connected. Call connect() first.');
    }
  }

  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    this.ensureClient();
    const model = config.model ?? this.defaultModel;
    return new AnthropicSession(this.anthropic, model, config.systemMessage);
  }

  async resumeSession(_sessionId: string, _config: SquadSessionConfig = {}): Promise<SquadSession> {
    throw new UnsupportedOperationError('resumeSession', 'anthropic',
      'Anthropic sessions are in-memory only. Start a new session instead.');
  }

  async listSessions(): Promise<SquadSessionMetadata[]> {
    return [];
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // No-op — in-memory sessions are GC'd when closed
  }

  async getLastSessionId(): Promise<string | undefined> {
    return undefined;
  }

  async ping(_message?: string): Promise<{ message: string; timestamp: number }> {
    this.ensureClient();
    return { message: 'pong', timestamp: Date.now() };
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return { version: 'anthropic', protocolVersion: 1 };
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    if (!this.anthropic) {
      return { isAuthenticated: false, statusMessage: 'Not connected' };
    }
    try {
      // Minimal API call to verify the key is valid
      await this.anthropic.models.list({ limit: 1 });
      return { isAuthenticated: true, authType: 'api-key', statusMessage: 'Authenticated with Anthropic API' };
    } catch {
      return { isAuthenticated: false, authType: 'api-key', statusMessage: 'Anthropic API key invalid or expired' };
    }
  }

  async listModels(): Promise<SquadModelInfo[]> {
    return ANTHROPIC_MODELS;
  }

  on<K extends SquadClientEventType>(eventType: K, handler: (event: SquadClientEvent & { type: K }) => void): () => void;
  on(handler: SquadClientEventHandler): () => void;
  on(
    _eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    _handler?: (event: SquadClientEvent) => void
  ): () => void {
    // Anthropic backend has no client-level lifecycle events
    return () => { /* no-op unsubscribe */ };
  }
}
