/**
 * Anthropic backend for squad, built on the Claude Agent SDK.
 *
 * Mirrors `gemini-client.ts`'s structure — a `SquadSession` plus a factory
 * implementing `SquadBackend` — so the two read as variants of one thing.
 *
 * Auth is inherited, not implemented: the SDK resolves credentials the same
 * way the `claude` CLI does (`ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`,
 * then the CLI's own login). squad writes no auth code and stores no
 * credential. Passing `--bare` or its option equivalent would disable that
 * chain, so it is never set.
 *
 * @module adapter/anthropic-client
 */

import { randomUUID } from 'node:crypto';
import { loadAgentSdk } from './anthropic/agent-sdk.js';
import type { AgentSdkMessage, AgentSdkQuery } from './anthropic/agent-sdk.js';
import {
  readAssistantText,
  readInit,
  readResult,
  readSessionId,
  readTextDelta,
  readToolUseStart,
  readToolUseStartIndex,
  readToolInputDelta,
  readToolResults,
  readContentBlockStopIndex,
} from './anthropic/normalize.js';
import { buildSquadMcpServer } from './anthropic/tool-bridge.js';
import type { SquadBackend } from './backend.js';
import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadSessionEventType,
  SquadMessageOptions,
  SquadGetAuthStatusResponse,
  SquadGetStatusResponse,
} from './types.js';

/** Default ceiling for `sendAndWait` when a caller gives none. */
const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/**
 * Built-in SDK tools a worker session gets alongside squad's own.
 *
 * These are the SDK's native file and shell tools. squad has hand-rolled
 * equivalents (`workstation_*`), but the native ones have materially better
 * ergonomics — Edit's stale-read detection, Bash's timeout and background
 * handling, Grep's ripgrep backend — and offering both would give the model
 * two overlapping toolsets to pick between.
 */
const DEFAULT_WORKER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// AnthropicSession
// ---------------------------------------------------------------------------

export class AnthropicSession implements SquadSession {
  readonly sessionId: string;

  private readonly config: SquadSessionConfig;
  private readonly listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private readonly abortController = new AbortController();

  /** Pending user messages, drained by the input generator. */
  private inbox: unknown[] = [];
  /** Wakes the input generator when a message arrives or the session closes. */
  private notify: (() => void) | null = null;
  private inputClosed = false;

  private query: AgentSdkQuery | null = null;
  private pump: Promise<void> | null = null;
  private closed = false;

  /** Resolves when the in-flight turn's `result` arrives. */
  private pendingTurn: Deferred<string> | null = null;
  /** Serializes turns so a concurrent send can't bind to another turn's result. */
  private turnChain: Promise<unknown> = Promise.resolve();
  /** Text accumulated for the turn currently in flight. */
  private turnText = '';
  /** True once a delta has arrived, so the complete `assistant` isn't double-counted. */
  private sawDelta = false;

  /**
   * Tool calls announced but not yet complete, keyed by content-block index.
   *
   * A tool_use block arrives as a header and then its arguments, so the call is
   * held here until the block closes and the two can be emitted together —
   * a tool_call event with no arguments records that something happened but not
   * what.
   */
  private readonly pendingToolCalls = new Map<number, { name: string; id?: string; json: string }>();
  /** Tool name by call id, so a result can name the tool it came from. */
  private readonly toolNamesById = new Map<string, string>();

  /**
   * Previous cumulative spend, so each turn's cost can be reported as a delta.
   *
   * Only cost is cumulative — token counts arrive per-turn and are passed
   * through untouched. See `NormalizedResult` for how that was established.
   */
  private lastCostUsd = 0;

  constructor(config: SquadSessionConfig) {
    // The SDK accepts a caller-supplied session id (verified), so squad's id
    // and the SDK's are one value rather than two that have to be correlated.
    this.sessionId = config.sessionId ?? randomUUID();
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  /**
   * Emit a held-open tool call now that its arguments have finished streaming.
   *
   * Malformed JSON yields empty arguments rather than dropping the event: that
   * a tool ran at all is the load-bearing fact, and losing it to a parse error
   * would put a hole in the trajectory precisely when something went wrong.
   */
  private flushPendingToolCall(index: number): void {
    const pending = this.pendingToolCalls.get(index);
    if (!pending) return;
    this.pendingToolCalls.delete(index);

    let args: Record<string, unknown> = {};
    if (pending.json.length > 0) {
      try {
        const parsed = JSON.parse(pending.json);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        /* keep the empty object — see above */
      }
    }
    if (pending.id) this.toolNamesById.set(pending.id, pending.name);
    this.emit({
      type: 'tool_call',
      toolName: pending.name,
      toolCallId: pending.id,
      arguments: args,
    });
  }

  private emit(event: SquadSessionEvent): void {
    for (const handler of this.listeners.get(event.type) ?? []) {
      try {
        handler(event);
      } catch {
        // A listener throwing is the listener's problem; it must not take
        // down the pump and strand the turn.
      }
    }
  }

  /** Emit streamed text under every key a consumer might read. */
  private emitDelta(text: string): void {
    this.emit({ type: 'message_delta', delta: text, text, content: text });
  }

  // -------------------------------------------------------------------------
  // Input stream
  // -------------------------------------------------------------------------

  private push(prompt: string): void {
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    });
    const wake = this.notify;
    this.notify = null;
    wake?.();
  }

  /**
   * Drives the SDK's streaming-input mode.
   *
   * Must never throw: the SDK surfaces a generator exception as the wholly
   * misleading "Claude Code process aborted by user".
   */
  private async *inputStream(): AsyncGenerator<unknown> {
    while (!this.inputClosed) {
      if (this.inbox.length === 0) {
        await new Promise<void>((resolve) => {
          this.notify = resolve;
        });
        continue;
      }
      yield this.inbox.shift()!;
    }
  }

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  private async buildOptions(): Promise<Record<string, unknown>> {
    const c = this.config;

    const options: Record<string, unknown> = {
      sessionId: this.sessionId,
      abortController: this.abortController,
      // Without both of these the SDK inherits the user's global Claude Code
      // configuration — `settingSources: []` alone still let their personal
      // MCP servers into the session (verified). Sessions must be reproducible
      // and must not silently acquire tools squad didn't grant.
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      includePartialMessages: c.streaming === true,
    };

    if (c.model) options['model'] = c.model;
    if (c.workingDirectory) options['cwd'] = c.workingDirectory;
    // squad's reasoning-effort union is a strict subset of the SDK's.
    if (c.reasoningEffort) options['effort'] = c.reasoningEffort;
    if (c.excludedTools) options['disallowedTools'] = c.excludedTools;

    // Bridge squad's own tools, and decide what the model may reach for.
    //
    // `tools: []` disables the SDK's built-ins outright (verified). That is
    // what preserves the coordinator's design: it routes work and must not
    // touch the filesystem, and simply omitting `tools` would leave every
    // built-in enabled by default rather than none.
    const squadTools = c.tools ?? [];
    const bridged = await buildSquadMcpServer(squadTools as never[], this.sessionId);

    if (bridged) {
      options['mcpServers'] = { squad: bridged.server };
      options['allowedTools'] = c.availableTools ?? [...DEFAULT_WORKER_TOOLS, ...bridged.toolNames];
    } else {
      // No squad tools: a coordinator or init session. Deny everything.
      options['tools'] = [];
      options['allowedTools'] = c.availableTools ?? [];
    }

    const system = c.systemMessage;
    if (system?.content) {
      options['systemPrompt'] =
        system.mode === 'replace'
          ? system.content
          : { type: 'preset', preset: 'claude_code', append: system.content };
    }

    return options;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private async start(): Promise<void> {
    const sdk = await loadAgentSdk();
    this.query = sdk.query({ prompt: this.inputStream(), options: await this.buildOptions() });
    this.pump = this.runPump();
  }

  /** Consumes the SDK's message stream and translates it to squad events. */
  private async runPump(): Promise<void> {
    try {
      for await (const message of this.query as AsyncIterable<AgentSdkMessage>) {
        this.handle(message);
      }
      // Iterator ended without a result for an outstanding turn.
      this.failPendingTurn(new Error('Anthropic session ended before the turn completed'));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit({ type: 'error', error: error.message });
      this.failPendingTurn(error);
    }
  }

  private handle(message: AgentSdkMessage): void {
    const init = readInit(message);
    if (init) {
      // Re-emitted once per turn, not once per session — treat as an
      // idempotent metadata refresh, never as "a new session started".
      this.emit({
        type: 'session_init',
        sessionId: readSessionId(message) ?? this.sessionId,
        model: init.model,
        tools: init.tools,
      });
      return;
    }

    const delta = readTextDelta(message);
    if (delta !== null) {
      this.sawDelta = true;
      this.turnText += delta;
      this.emitDelta(delta);
      return;
    }

    const toolUse = readToolUseStart(message);
    if (toolUse) {
      // Hold the call open: its arguments stream in afterwards as
      // `input_json_delta` fragments, and the event is only worth emitting
      // once they can be attached to it.
      const index = readToolUseStartIndex(message);
      if (index !== null) {
        this.pendingToolCalls.set(index, { name: toolUse.name, id: toolUse.id, json: '' });
      } else {
        this.emit({ type: 'tool_call', toolName: toolUse.name, toolCallId: toolUse.id });
      }
      return;
    }

    const inputDelta = readToolInputDelta(message);
    if (inputDelta) {
      const pending = this.pendingToolCalls.get(inputDelta.index);
      if (pending) pending.json += inputDelta.fragment;
      return;
    }

    const stopIndex = readContentBlockStopIndex(message);
    if (stopIndex !== null && this.pendingToolCalls.has(stopIndex)) {
      this.flushPendingToolCall(stopIndex);
      return;
    }

    // A tool finished. Emitting the result is what turns `tool_call` from "a
    // tool was requested" into a lifecycle with an outcome — the half that
    // was missing, and the reason nothing downstream could tell a denied tool
    // from a broken one.
    const toolResults = readToolResults(message);
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        this.emit({
          type: 'tool_result',
          toolName: this.toolNamesById.get(result.toolCallId) ?? 'unknown',
          toolCallId: result.toolCallId,
          result: result.isError
            ? { error: result.content, resultType: 'failure' }
            : { textResultForLlm: result.content, resultType: 'success' },
        });
        this.toolNamesById.delete(result.toolCallId);
      }
      return;
    }

    if (message.type === 'assistant') {
      // With partial messages on, this text already arrived as deltas.
      // Emitting it again would double every response.
      if (!this.sawDelta) {
        for (const text of readAssistantText(message)) {
          this.turnText += text;
          this.emitDelta(text);
        }
      }
      return;
    }

    const result = readResult(message);
    if (result) {
      this.completeTurn(result);
      return;
    }

    // Everything else — system/status, system/thinking_tokens,
    // rate_limit_event, user/tool_result, and whatever ships next — is
    // deliberately ignored rather than warned about.
  }

  private completeTurn(result: ReturnType<typeof readResult> & object): void {
    // Token counts are already per-turn; only cost needs differencing.
    // Diffing the tokens too reported 0/0 for every turn after the first.
    const cost = result.cumulativeCostUsd ?? this.lastCostUsd;
    this.emit({
      type: 'usage',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: Math.max(0, cost - this.lastCostUsd),
      model: result.model ?? this.config.model ?? null,
    });
    this.lastCostUsd = cost;

    const pending = this.pendingTurn;
    this.pendingTurn = null;

    if (!result.ok) {
      const error = new Error(result.errorMessage ?? 'agent run failed');
      this.emit({ type: 'error', error: error.message });
      pending?.reject(error);
      return;
    }

    this.emit({ type: 'turn_end' });
    // Prefer streamed text; fall back to the result's own summary when the
    // caller never asked for partial messages.
    pending?.resolve(this.turnText || result.text);
  }

  private failPendingTurn(error: Error): void {
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending?.reject(error);
  }

  // -------------------------------------------------------------------------
  // SquadSession
  // -------------------------------------------------------------------------

  /**
   * Send a message and resolve once the turn is complete.
   *
   * Turns are serialized: a second call while one is in flight queues behind
   * it rather than racing for the same `result` message.
   */
  async sendMessage(options: SquadMessageOptions): Promise<void> {
    await this.runTurn(options.prompt);
  }

  /** As `sendMessage`, but returns the turn's text and enforces a timeout. */
  async sendAndWait(options: SquadMessageOptions, timeout = DEFAULT_TURN_TIMEOUT_MS): Promise<unknown> {
    return this.runTurn(options.prompt, timeout);
  }

  private runTurn(prompt: string, timeoutMs?: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Session is closed'));

    const run = async (): Promise<string> => {
      if (this.closed) throw new Error('Session is closed');
      if (!this.query) await this.start();

      this.turnText = '';
      this.sawDelta = false;
      const pending = defer<string>();
      this.pendingTurn = pending;
      this.push(prompt);

      if (timeoutMs === undefined) return pending.promise;

      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          pending.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void this.abort();
              reject(new Error(`Anthropic turn timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // Chain regardless of whether the previous turn succeeded, so one failure
    // doesn't wedge the session for every turn after it.
    const next = this.turnChain.then(run, run);
    this.turnChain = next.catch(() => undefined);
    return next;
  }

  async abort(): Promise<void> {
    try {
      await this.query?.interrupt?.();
    } catch {
      // Older CLIs resolve interrupt() to undefined or reject; the abort
      // controller below is the backstop either way.
    }
    this.abortController.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.inputClosed = true;
    const wake = this.notify;
    this.notify = null;
    wake?.();

    try {
      // Teardown is the generator protocol's return(), not a close() method.
      await this.query?.return?.(undefined);
    } catch {
      // Already finished.
    }
    this.abortController.abort();

    this.failPendingTurn(new Error('Session closed before the turn completed'));
    try {
      await this.pump;
    } catch {
      // Pump errors already surfaced as `error` events.
    }
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// AnthropicClient
// ---------------------------------------------------------------------------

export class AnthropicClient implements SquadBackend {
  private started = false;

  /**
   * @param apiKey - optional explicit key. When absent the SDK falls back to
   *   the same credential chain the `claude` CLI uses, which is the normal
   *   path — squad neither prompts for nor stores a credential.
   */
  constructor(private readonly apiKey?: string) {}

  async start(): Promise<void> {
    // Fails fast and with an actionable message if the package is missing.
    await loadAgentSdk();
    this.started = true;
  }

  async stop(): Promise<Error[]> {
    this.started = false;
    return [];
  }

  isStarted(): boolean {
    return this.started;
  }

  createSession(config: SquadSessionConfig): SquadSession {
    return new AnthropicSession(config);
  }

  /**
   * Report whether a credential is reachable.
   *
   * Deliberately does not spend tokens to find out: a real probe would cost
   * money on every `squad doctor`. Resolving the package is the honest
   * signal squad can give for free — an actually-invalid credential surfaces
   * on first use with the SDK's own error.
   */
  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    try {
      await loadAgentSdk();
    } catch (err) {
      return {
        isAuthenticated: false,
        statusMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.apiKey || process.env['ANTHROPIC_API_KEY']) {
      return { isAuthenticated: true, authType: 'api-key', statusMessage: 'Using ANTHROPIC_API_KEY' };
    }
    return {
      isAuthenticated: true,
      authType: 'user',
      statusMessage: 'Using the credentials your local `claude` CLI is signed in with',
    };
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return { version: 'anthropic', protocolVersion: 1 };
  }
}
