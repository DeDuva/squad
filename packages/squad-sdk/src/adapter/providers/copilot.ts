/**
 * Copilot Provider Backend
 *
 * Implements ISquadClientBackend using @github/copilot-sdk.
 * This is the original Squad implementation, extracted from adapter/client.ts
 * to make room for alternative provider backends.
 *
 * Requires: @github/copilot-sdk (listed as optionalDependency)
 * Auth: GitHub login or GITHUB_TOKEN env var
 *
 * @module adapter/providers/copilot
 */

import { CopilotClient } from '@github/copilot-sdk';
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
import type { SquadClientOptions } from '../client.js';

// ---------------------------------------------------------------------------
// CopilotSessionAdapter
// ---------------------------------------------------------------------------

/**
 * Adapts @github/copilot-sdk CopilotSession to our SquadSession interface.
 * Maps sendMessage() → send(), off() via unsubscribe tracking, close() → destroy().
 */
class CopilotSessionAdapter implements SquadSession {
  /**
   * Maps Squad short event names → @github/copilot-sdk dotted event names.
   */
  private static readonly EVENT_MAP: Record<string, string> = {
    'message_delta': 'assistant.message_delta',
    'message': 'assistant.message',
    'usage': 'assistant.usage',
    'reasoning_delta': 'assistant.reasoning_delta',
    'reasoning': 'assistant.reasoning',
    'turn_start': 'assistant.turn_start',
    'turn_end': 'assistant.turn_end',
    'intent': 'assistant.intent',
    'idle': 'session.idle',
    'error': 'session.error',
  };

  private static readonly REVERSE_EVENT_MAP: Record<string, string> = Object.fromEntries(
    Object.entries(CopilotSessionAdapter.EVENT_MAP).map(([k, v]) => [v, k])
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly inner: any;
  private readonly unsubscribers = new Map<SquadSessionEventHandler, Map<string, () => void>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(copilotSession: any) {
    this.inner = copilotSession;
  }

  get sessionId(): string {
    return this.inner.sessionId ?? 'unknown';
  }

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    await this.inner.send(options);
  }

  async sendAndWait(options: SquadMessageOptions, timeout?: number): Promise<unknown> {
    return await this.inner.sendAndWait(options, timeout);
  }

  async abort(): Promise<void> {
    await this.inner.abort();
  }

  async getMessages(): Promise<unknown[]> {
    return await this.inner.getMessages();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static normalizeEvent(sdkEvent: any): SquadSessionEvent {
    const squadType = CopilotSessionAdapter.REVERSE_EVENT_MAP[sdkEvent.type] ?? sdkEvent.type;
    return {
      type: squadType,
      ...(sdkEvent.data ?? {}),
    };
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    const sdkType = CopilotSessionAdapter.EVENT_MAP[eventType] ?? eventType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = (sdkEvent: any) => {
      handler(CopilotSessionAdapter.normalizeEvent(sdkEvent));
    };
    const unsubscribe = this.inner.on(sdkType, wrappedHandler);
    if (!this.unsubscribers.has(handler)) {
      this.unsubscribers.set(handler, new Map());
    }
    this.unsubscribers.get(handler)!.set(eventType, unsubscribe);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    const handlerMap = this.unsubscribers.get(handler);
    if (handlerMap) {
      const unsubscribe = handlerMap.get(eventType);
      if (unsubscribe) {
        unsubscribe();
        handlerMap.delete(eventType);
      }
      if (handlerMap.size === 0) {
        this.unsubscribers.delete(handler);
      }
    }
  }

  async close(): Promise<void> {
    await this.inner.destroy();
    this.unsubscribers.clear();
  }
}

// ---------------------------------------------------------------------------
// CopilotBackend
// ---------------------------------------------------------------------------

/**
 * ISquadClientBackend implementation backed by @github/copilot-sdk.
 *
 * Wraps CopilotClient with connection lifecycle management, automatic
 * reconnection with exponential backoff, and protocol version validation.
 */
export class CopilotBackend implements ISquadClientBackend {
  private client: CopilotClient;
  private _isConnected = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private options: Required<Omit<SquadClientOptions, 'cliUrl' | 'githubToken' | 'useLoggedInUser' | 'cliPath' | 'cliArgs' | 'eventBus' | 'provider' | 'anthropic' | 'gemini'>> & {
    cliUrl?: string;
    githubToken?: string;
    useLoggedInUser?: boolean;
    cliPath?: string;
    cliArgs: string[];
    eventBus?: SquadClientOptions['eventBus'];
  };

  constructor(options: SquadClientOptions = {}) {
    this.options = {
      cliPath: options.cliPath,
      cliArgs: options.cliArgs ?? [],
      cwd: options.cwd ?? process.cwd(),
      port: options.port ?? 0,
      useStdio: options.useStdio ?? true,
      cliUrl: options.cliUrl,
      logLevel: options.logLevel ?? 'debug',
      autoStart: options.autoStart ?? true,
      autoReconnect: options.autoReconnect ?? true,
      env: options.env ?? (process.env as Record<string, string>),
      githubToken: options.githubToken,
      useLoggedInUser: options.useLoggedInUser ?? (options.githubToken ? false : true),
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
      reconnectDelayMs: options.reconnectDelayMs ?? 1000,
      eventBus: options.eventBus,
    };

    this.client = new CopilotClient({
      cliPath: this.options.cliPath,
      cliArgs: this.options.cliArgs,
      cwd: this.options.cwd,
      port: this.options.port,
      useStdio: this.options.useStdio,
      cliUrl: this.options.cliUrl,
      logLevel: this.options.logLevel,
      autoStart: false,
      autoRestart: false,
      env: this.options.env,
      githubToken: this.options.githubToken,
      useLoggedInUser: this.options.useLoggedInUser,
    });
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;
    if (this.connectPromise) return this.connectPromise;

    this.manualDisconnect = false;
    this.connectPromise = (async () => {
      try {
        await this.client.start();
        this._isConnected = true;
        this.reconnectAttempts = 0;
      } catch (error) {
        this._isConnected = false;
        throw new Error(
          `Failed to connect to Copilot CLI: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  async disconnect(): Promise<Error[]> {
    this.manualDisconnect = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const errors = await this.client.stop();
    this._isConnected = false;
    this.reconnectAttempts = 0;
    this.connectPromise = null;
    return errors;
  }

  async forceDisconnect(): Promise<void> {
    this.manualDisconnect = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    await this.client.forceStop();
    this._isConnected = false;
    this.reconnectAttempts = 0;
    this.connectPromise = null;
  }

  async createSession(config: SquadSessionConfig = {}): Promise<SquadSession> {
    if (!this._isConnected && this.options.autoStart) await this.connect();
    if (!this._isConnected) throw new Error('Client not connected. Call connect() first.');

    try {
      const session = await this.client.createSession(config as Parameters<typeof this.client.createSession>[0]);
      return new CopilotSessionAdapter(session);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('onPermissionRequest')) {
        throw new Error(
          'Session creation failed: an onPermissionRequest handler is required. ' +
          'Pass { onPermissionRequest: () => ({ kind: "approved" }) } in your session config.'
        );
      }
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.createSession(config);
      }
      throw error;
    }
  }

  async resumeSession(sessionId: string, config: SquadSessionConfig = {}): Promise<SquadSession> {
    if (!this._isConnected && this.options.autoStart) await this.connect();
    if (!this._isConnected) throw new Error('Client not connected. Call connect() first.');
    try {
      const session = await this.client.resumeSession(sessionId, config as Parameters<typeof this.client.resumeSession>[1]);
      return new CopilotSessionAdapter(session);
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.resumeSession(sessionId, config);
      }
      throw error;
    }
  }

  async listSessions(): Promise<SquadSessionMetadata[]> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      const sessions = await this.client.listSessions();
      return sessions.map((s): SquadSessionMetadata => ({
        sessionId: s.sessionId,
        startTime: s.startTime,
        modifiedTime: s.modifiedTime,
        summary: s.summary,
        isRemote: s.isRemote,
        context: s.context as Record<string, unknown> | undefined,
      }));
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.listSessions();
      }
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      await this.client.deleteSession(sessionId);
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.deleteSession(sessionId);
      }
      throw error;
    }
  }

  async getLastSessionId(): Promise<string | undefined> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      return await this.client.getLastSessionId();
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.getLastSessionId();
      }
      throw error;
    }
  }

  async ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      return await this.client.ping(message);
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.ping(message);
      }
      throw error;
    }
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      const raw = await this.client.getStatus();
      return { version: raw.version, protocolVersion: raw.protocolVersion };
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.getStatus();
      }
      throw error;
    }
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      const raw = await this.client.getAuthStatus();
      return {
        isAuthenticated: raw.isAuthenticated,
        authType: raw.authType,
        host: raw.host,
        login: raw.login,
        statusMessage: raw.statusMessage,
      };
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.getAuthStatus();
      }
      throw error;
    }
  }

  async listModels(): Promise<SquadModelInfo[]> {
    if (!this._isConnected) throw new Error('Client not connected');
    try {
      const models = await this.client.listModels();
      return models.map((m): SquadModelInfo => ({
        id: m.id,
        name: m.name,
        capabilities: m.capabilities,
        policy: m.policy,
        billing: m.billing,
        supportedReasoningEfforts: m.supportedReasoningEfforts,
        defaultReasoningEffort: m.defaultReasoningEffort,
      }));
    } catch (error) {
      if (this.shouldAttemptReconnect(error)) {
        await this.attemptReconnection();
        return this.listModels();
      }
      throw error;
    }
  }

  on<K extends SquadClientEventType>(eventType: K, handler: (event: SquadClientEvent & { type: K }) => void): () => void;
  on(handler: SquadClientEventHandler): () => void;
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void
  ): () => void {
    if (typeof eventTypeOrHandler === 'string' && handler) {
      return this.client.on(eventTypeOrHandler, handler);
    } else {
      return this.client.on(eventTypeOrHandler as SquadClientEventHandler);
    }
  }

  private shouldAttemptReconnect(error: unknown): boolean {
    if (!this.options.autoReconnect || this.manualDisconnect) return false;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) return false;
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ECONNREFUSED') ||
      message.includes('ECONNRESET') ||
      message.includes('EPIPE') ||
      message.includes('Client not connected') ||
      message.includes('Connection closed')
    );
  }

  private async attemptReconnection(): Promise<void> {
    this._isConnected = false;
    this.reconnectAttempts++;
    const delay = this.options.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    await new Promise((resolve) => { this.reconnectTimer = setTimeout(resolve, delay); });
    try {
      await this.client.stop();
      await this.client.start();
      this._isConnected = true;
      this.reconnectAttempts = 0;
    } catch (error) {
      this._isConnected = false;
      throw new Error(
        `Reconnection attempt ${this.reconnectAttempts} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
