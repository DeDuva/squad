/**
 * Gemini Provider Backend
 *
 * Implements ISquadClientBackend using @google/genai (Google Gemini API).
 * Each SquadSession maintains its own conversation history for multi-turn
 * interactions.
 *
 * Requires: @google/genai (listed as optionalDependency)
 * Auth: GEMINI_API_KEY environment variable or options.gemini.apiKey
 *
 * Model tiers:
 *   lightweight → gemini-2.0-flash
 *   standard    → gemini-2.5-flash  (default)
 *   full        → gemini-2.5-pro
 *
 * @module adapter/providers/gemini
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
// Lazy SDK import
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _GoogleGenAI: any = null;

async function getGeminiSDK(): Promise<any> {
  if (_GoogleGenAI) return _GoogleGenAI;
  try {
    const mod = await import('@google/genai');
    _GoogleGenAI = mod.GoogleGenAI ?? (mod as any).default?.GoogleGenAI ?? mod;
    return _GoogleGenAI;
  } catch {
    throw new Error(
      'The Gemini provider requires @google/genai. ' +
      'Install it with: npm install @google/genai'
    );
  }
}

// ---------------------------------------------------------------------------
// Gemini content history type
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

// ---------------------------------------------------------------------------
// GeminiSession
// ---------------------------------------------------------------------------

/**
 * A stateful conversation session backed by the Google Gemini API.
 *
 * Maintains Gemini-format content history for multi-turn conversations.
 * Emits Squad-standard events during streaming:
 *   message_delta  — { delta: string }                    text chunk
 *   usage          — { inputTokens, outputTokens, model } after stream ends
 *   idle           — stream complete
 *   error          — { error: string }                    non-fatal error
 */
export class GeminiSession implements SquadSession {
  readonly sessionId: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly ai: any;
  private readonly model: string;
  private readonly systemInstruction: string;
  private history: GeminiContent[] = [];
  private listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private currentAbortController: AbortController | null = null;
  private closed = false;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ai: any,
    model: string,
    systemMessage?: SquadSessionConfig['systemMessage'],
  ) {
    this.sessionId = randomUUID();
    this.ai = ai;
    this.model = model;
    this.systemInstruction = systemMessage?.mode === 'replace'
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

    // Append user turn to history
    this.history.push({ role: 'user', parts: [{ text: options.prompt }] });

    let accumulated = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const requestConfig: Record<string, unknown> = {
        model: this.model,
        contents: this.history,
      };
      if (this.systemInstruction) {
        requestConfig['config'] = { systemInstruction: this.systemInstruction };
      }

      const response = await this.ai.models.generateContentStream(requestConfig);

      for await (const chunk of response) {
        const text: string = chunk.text ?? '';
        if (text) {
          accumulated += text;
          this.emit({ type: 'message_delta', delta: text });
        }
        // Usage metadata is typically on the final chunk
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      // Append model reply to history
      if (accumulated) {
        this.history.push({ role: 'model', parts: [{ text: accumulated }] });
      }

      this.emit({ type: 'usage', inputTokens, outputTokens, model: this.model });
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

    this.history.push({ role: 'user', parts: [{ text: options.prompt }] });

    const requestConfig: Record<string, unknown> = {
      model: this.model,
      contents: this.history,
    };
    if (this.systemInstruction) {
      requestConfig['config'] = { systemInstruction: this.systemInstruction };
    }

    try {
      const response = await this.ai.models.generateContentStream(requestConfig);

      let accumulated = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of response) {
        accumulated += chunk.text ?? '';
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      if (accumulated) this.history.push({ role: 'model', parts: [{ text: accumulated }] });

      this.emit({ type: 'usage', inputTokens, outputTokens, model: this.model });
      this.emit({ type: 'idle' });

      return accumulated;
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
// GeminiBackend
// ---------------------------------------------------------------------------

const GEMINI_MODELS: SquadModelInfo[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 1000000 } },
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 1000000 } },
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 1000000 } },
  },
];

/**
 * ISquadClientBackend implementation using the Google Gemini API directly.
 *
 * No subprocess required — connects directly to generativelanguage.googleapis.com.
 * Session history is maintained in-memory per GeminiSession.
 */
export class GeminiBackend implements ISquadClientBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ai: any = null;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: SquadClientOptions = {}) {
    this.apiKey = options.gemini?.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
    this.defaultModel = options.gemini?.model ?? 'gemini-2.5-flash';
  }

  isConnected(): boolean {
    return true; // REST providers are always "connected"
  }

  async connect(): Promise<void> {
    const GoogleGenAI = await getGeminiSDK();
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key required. Set GEMINI_API_KEY environment variable ' +
        'or pass gemini.apiKey in SquadClientOptions.'
      );
    }
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
  }

  async disconnect(): Promise<Error[]> {
    this.ai = null;
    return [];
  }

  async forceDisconnect(): Promise<void> {
    this.ai = null;
  }

  private ensureClient(): void {
    if (!this.ai) {
      throw new Error('GeminiBackend not connected. Call connect() first.');
    }
  }

  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    this.ensureClient();
    const model = config.model ?? this.defaultModel;
    return new GeminiSession(this.ai, model, config.systemMessage);
  }

  async resumeSession(_sessionId: string, _config: SquadSessionConfig = {}): Promise<SquadSession> {
    throw new UnsupportedOperationError('resumeSession', 'gemini',
      'Gemini sessions are in-memory only. Start a new session instead.');
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
    return { version: 'gemini', protocolVersion: 1 };
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    if (!this.ai) {
      return { isAuthenticated: false, statusMessage: 'Not connected' };
    }
    try {
      // Minimal API call to verify the key
      await this.ai.models.list({ config: { pageSize: 1 } });
      return { isAuthenticated: true, authType: 'api-key', statusMessage: 'Authenticated with Gemini API' };
    } catch {
      return { isAuthenticated: false, authType: 'api-key', statusMessage: 'Gemini API key invalid or expired' };
    }
  }

  async listModels(): Promise<SquadModelInfo[]> {
    return GEMINI_MODELS;
  }

  on<K extends SquadClientEventType>(eventType: K, handler: (event: SquadClientEvent & { type: K }) => void): () => void;
  on(handler: SquadClientEventHandler): () => void;
  on(
    _eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    _handler?: (event: SquadClientEvent) => void
  ): () => void {
    return () => { /* no-op — Gemini backend has no client-level lifecycle events */ };
  }
}
