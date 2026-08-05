/**
 * Gemini API backend for Squad.
 *
 * Implements SquadSession and a factory GeminiClient using the Gemini
 * REST API via Node's built-in fetch — no npm packages required.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/
 */

import { randomUUID } from 'node:crypto';
import type { SquadBackend } from './backend.js';
import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadSessionEventType,
  SquadMessageOptions,
  SquadTool,
  SquadReasoningEffort,
  SquadGetAuthStatusResponse,
  SquadSessionMetadata,
  SquadGetStatusResponse,
  SquadModelInfo,
  SquadSessionHooks,
  SquadPreToolUseHookInput,
  SquadPostToolUseHookInput,
  SquadToolResultObject,
} from './types.js';

// ---------------------------------------------------------------------------
// Gemini REST API wire types (minimal subset we need)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: unknown } };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiGenerationConfig {
  thinkingConfig?: { thinkingBudget: number };
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: [{ text: string }] };
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
}

interface GeminiResponseChunk {
  error?: {
    code: number;
    message: string;
    status: string;
  };
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
      role?: string;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// SSE reader — parses `data: {...}` lines from a ReadableStream<Uint8Array>
// ---------------------------------------------------------------------------

const DEBUG_GEMINI = process.env['SQUAD_DEBUG_GEMINI'] === '1';

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponseChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let chunkIndex = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (DEBUG_GEMINI) process.stderr.write(`[gemini-debug] SSE stream done after ${chunkIndex} chunks\n`);
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (DEBUG_GEMINI && trimmed) process.stderr.write(`[gemini-debug] raw line: ${trimmed}\n`);
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const parsed = JSON.parse(json) as GeminiResponseChunk;
          if (DEBUG_GEMINI) process.stderr.write(`[gemini-debug] chunk[${chunkIndex}]: ${JSON.stringify(parsed)}\n`);
          chunkIndex++;
          yield parsed;
        } catch {
          if (DEBUG_GEMINI) process.stderr.write(`[gemini-debug] malformed chunk: ${json}\n`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Tool translation: SquadTool[] → Gemini FunctionDeclaration[]
// ---------------------------------------------------------------------------

function toGeminiTools(tools: SquadTool[]): GeminiTool[] {
  if (tools.length === 0) return [];

  const declarations: GeminiFunctionDeclaration[] = tools.map(tool => {
    let parameters: Record<string, unknown> | undefined;

    if (tool.parameters) {
      if (typeof (tool.parameters as any).toJSONSchema === 'function') {
        // Zod-like schema
        parameters = (tool.parameters as any).toJSONSchema() as Record<string, unknown>;
      } else {
        parameters = tool.parameters as Record<string, unknown>;
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      ...(parameters ? { parameters } : {}),
    };
  });

  return [{ functionDeclarations: declarations }];
}

// ---------------------------------------------------------------------------
// Reasoning effort → Gemini thinkingBudget
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<SquadReasoningEffort, number> = {
  low:   1024,
  medium: 8192,
  high:  24576,
  xhigh: 32768,
};

// ---------------------------------------------------------------------------
// GeminiSession — implements SquadSession
// ---------------------------------------------------------------------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiSession implements SquadSession {
  readonly sessionId: string;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly tools: SquadTool[];
  private readonly systemPrompt: string | undefined;
  private readonly thinkingBudget: number | undefined;
  private readonly hooks: SquadSessionHooks | undefined;
  private readonly maxToolCallRounds: number;

  private history: GeminiContent[] = [];
  private listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private abortController: AbortController | null = null;
  private closed = false;
  private toolCallRound = 0;
  /** Wall-clock start of the current user turn, for the usage event's duration. */
  private turnStartedAt: number | null = null;

  constructor(
    apiKey: string,
    config: SquadSessionConfig,
  ) {
    this.sessionId = config.sessionId ?? randomUUID();
    this.apiKey = apiKey;
    this.model = config.model ?? 'gemini-flash-latest';
    this.tools = config.tools ?? [];

    // System message
    if (config.systemMessage?.mode === 'replace') {
      this.systemPrompt = config.systemMessage.content;
    } else if (config.systemMessage?.mode === 'append' || !config.systemMessage?.mode) {
      this.systemPrompt = config.systemMessage?.content;
    }

    // Reasoning effort
    if (config.reasoningEffort) {
      this.thinkingBudget = THINKING_BUDGETS[config.reasoningEffort];
    }

    this.hooks = config.hooks;
    this.maxToolCallRounds = config.maxToolCallRounds ?? 10;

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      console.warn(
        '[squad-sdk] mcpServers config is not yet implemented in the Gemini backend. ' +
        'MCP tool capabilities will not be available in this session.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Event emitter (minimal, synchronous)
  // -------------------------------------------------------------------------

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  private emit(event: SquadSessionEvent): void {
    this.listeners.get(event.type)?.forEach(h => h(event));
  }

  // -------------------------------------------------------------------------
  // sendMessage — streams from Gemini, emits Squad events
  // -------------------------------------------------------------------------

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    // Reset round counter at the start of each user-initiated turn (not recursive continuations).
    // Recursive calls use { prompt: '' }; user turns always have a non-empty prompt.
    if (options.prompt !== '') {
      this.toolCallRound = 0;
      // Turn start, so the usage event can report a duration. Set only on
      // user-initiated turns: a recursive tool continuation is part of the
      // same turn, and restarting the clock would report the tail as the whole.
      this.turnStartedAt = Date.now();
    }

    this.abortController = new AbortController();

    // Append user turn
    const userParts: GeminiPart[] = [{ text: options.prompt }];
    this.history.push({ role: 'user', parts: userParts });

    // Build request
    const body: GeminiRequest = {
      contents: this.history,
      ...(this.systemPrompt
        ? { systemInstruction: { parts: [{ text: this.systemPrompt }] } }
        : {}),
      ...(this.tools.length > 0 ? { tools: toGeminiTools(this.tools) } : {}),
      // Only send thinkingConfig when a budget is explicitly requested.
      // gemini-pro-latest rejects thinkingBudget=0 ("only works in thinking mode").
      ...(this.thinkingBudget
        ? { generationConfig: { thinkingConfig: { thinkingBudget: this.thinkingBudget } } }
        : {}),
    };

    const url = `${GEMINI_BASE}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });
    } catch (err) {
      this.abortController = null;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', error: message });
      throw err;
    }

    if (!response.ok) {
      this.abortController = null;
      const text = await response.text().catch(() => '');
      const message = `Gemini API error ${response.status}: ${text}`;
      this.emit({ type: 'error', error: message });
      throw new Error(message);
    }

    if (!response.body) {
      this.abortController = null;
      throw new Error('Gemini API returned no response body');
    }

    // Accumulate the full model turn across SSE chunks
    const modelParts: GeminiPart[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let pendingToolCalls: Array<{ name: string; args: Record<string, unknown>; callId: string }> = [];

    try {
      for await (const chunk of readSSE(response.body)) {
        if (chunk.error) {
          throw new Error(`Gemini API error ${chunk.error.code}: ${JSON.stringify(chunk.error)}`);
        }

        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text !== undefined && !part.thought) {
            modelParts.push({ text: part.text });
            // Consumers disagree on which key carries the text: the shell reads
            // `deltaContent ?? delta ?? content ?? text`, while spawnAgent reads
            // `delta ?? content`. Emitting all three keeps both working no
            // matter which key a given caller reaches for first.
            this.emit({ type: 'message_delta', delta: part.text, text: part.text, content: part.text });
          }

          if (part.functionCall) {
            const callId = randomUUID();
            pendingToolCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args,
              callId,
            });
            modelParts.push({ functionCall: part.functionCall });
          }
        }

        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }
    } finally {
      this.abortController = null;
    }

    // Append model turn to history
    if (modelParts.length > 0) {
      this.history.push({ role: 'model', parts: modelParts });
    }

    // Handle tool calls: invoke handlers, append results, recurse once
    if (pendingToolCalls.length > 0) {
      await this.handleToolCalls(pendingToolCalls);
      return; // recursive call emits its own turn_end/usage
    }

    // Emit usage and turn_end
    this.emit({
      type: 'usage',
      inputTokens,
      outputTokens,
      model: this.model,
      durationMs: this.turnStartedAt === null ? undefined : Date.now() - this.turnStartedAt,
    });

    this.emit({ type: 'turn_end' });
  }

  // -------------------------------------------------------------------------
  // Tool call dispatch
  // -------------------------------------------------------------------------

  private async handleToolCalls(
    calls: Array<{ name: string; args: Record<string, unknown>; callId: string }>,
  ): Promise<void> {
    this.toolCallRound++;
    if (this.toolCallRound > this.maxToolCallRounds) {
      throw new Error(
        `Tool call depth exceeded maxToolCallRounds (${this.maxToolCallRounds}). ` +
        `This usually means a tool is returning function calls in a loop.`,
      );
    }

    const toolMap = new Map(this.tools.map(t => [t.name, t]));
    const responseParts: GeminiPart[] = [];

    for (const call of calls) {
      const tool = toolMap.get(call.name);

      this.emit({
        type: 'tool_call',
        toolName: call.name,
        toolCallId: call.callId,
        arguments: call.args,
      });

      let result: unknown;

      // Pre-tool hook
      const preInput: SquadPreToolUseHookInput = {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: call.name,
        toolArgs: call.args,
      };
      const preOutput = await this.hooks?.onPreToolUse?.(preInput, { sessionId: this.sessionId });

      if (preOutput?.permissionDecision === 'deny') {
        result = {
          textResultForLlm: `Tool use denied: ${preOutput.permissionDecisionReason ?? 'no reason given'}`,
          resultType: 'rejected',
        };
      } else if (tool) {
        const effectiveArgs = (preOutput?.modifiedArgs ?? call.args) as Record<string, unknown>;
        try {
          result = await tool.handler(effectiveArgs, {
            sessionId: this.sessionId,
            toolCallId: call.callId,
            toolName: call.name,
            arguments: effectiveArgs,
          });
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        result = { error: `Unknown tool: ${call.name}` };
      }

      // Post-tool hook
      const postInput: SquadPostToolUseHookInput = {
        timestamp: Date.now(),
        cwd: process.cwd(),
        toolName: call.name,
        toolArgs: call.args,
        toolResult: result as SquadToolResultObject,
      };
      const postOutput = await this.hooks?.onPostToolUse?.(postInput, { sessionId: this.sessionId });
      if (postOutput?.modifiedResult !== undefined) {
        result = postOutput.modifiedResult;
      }

      this.emit({
        type: 'tool_result',
        toolName: call.name,
        toolCallId: call.callId,
        result,
      });

      responseParts.push({
        functionResponse: {
          name: call.name,
          response: { content: result },
        },
      });
    }

    // Append tool results as user turn and continue generation
    this.history.push({ role: 'user', parts: responseParts });
    await this.sendMessage({ prompt: '' });
  }

  // -------------------------------------------------------------------------
  // sendAndWait — sends and resolves with the final assistant text
  // -------------------------------------------------------------------------

  async sendAndWait(options: SquadMessageOptions, _timeout?: number): Promise<unknown> {
    let finalText = '';
    const handler = (event: SquadSessionEvent) => {
      if (event.type === 'message_delta' && typeof event['text'] === 'string') {
        finalText += event['text'] as string;
      }
    };
    this.on('message_delta', handler);
    try {
      await this.sendMessage(options);
    } finally {
      this.off('message_delta', handler);
    }
    return finalText;
  }

  // -------------------------------------------------------------------------
  // abort / getMessages / close
  // -------------------------------------------------------------------------

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  async getMessages(): Promise<unknown[]> {
    return this.history.map(c => ({
      role: c.role,
      content: c.parts.map(p => p.text ?? '').join(''),
    }));
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.closed = true;
    this.listeners.clear();
    this.history = [];
  }
}

// ---------------------------------------------------------------------------
// GeminiClient — validates the API key and creates sessions
// ---------------------------------------------------------------------------

export class GeminiClient implements SquadBackend {
  private apiKey: string;
  private connected = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async start(): Promise<void> {
    if (!this.apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Run "squad auth setup --provider=gemini" or set the environment variable.',
      );
    }

    // Lightweight connectivity check — list models endpoint
    const res = await fetch(`${GEMINI_BASE}/models?key=${this.apiKey}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini authentication failed (${res.status}): ${body}`);
    }

    this.connected = true;
  }

  async stop(): Promise<Error[]> {
    this.connected = false;
    return [];
  }

  isStarted(): boolean {
    return this.connected;
  }

  createSession(config: SquadSessionConfig): GeminiSession {
    return new GeminiSession(this.apiKey, config);
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    if (!this.apiKey) {
      return { isAuthenticated: false, statusMessage: 'No API key configured' };
    }
    try {
      const res = await fetch(`${GEMINI_BASE}/models?key=${this.apiKey}`);
      if (res.ok) {
        return { isAuthenticated: true, authType: 'api-key', statusMessage: 'Gemini API key valid' };
      }
      return { isAuthenticated: false, statusMessage: `Gemini API returned ${res.status}` };
    } catch (err) {
      return {
        isAuthenticated: false,
        statusMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Optional SquadBackend members --------------------------------------
  // These used to live as hardcoded returns inside SquadClient, which made
  // "Gemini is stateless" read as a fact about squad. They are Gemini's
  // answers, so they belong to Gemini.

  /** Gemini is stateless — there is no server-side session list to fetch. */
  async listSessions(): Promise<SquadSessionMetadata[]> {
    return [];
  }

  /** No server-side sessions means no "last" one. */
  async getLastSessionId(): Promise<string | undefined> {
    return undefined;
  }

  async getStatus(): Promise<SquadGetStatusResponse> {
    return { version: 'gemini', protocolVersion: 1 };
  }

  /** The local catalog is authoritative in airlock mode; no live listing needed. */
  async listModels(): Promise<SquadModelInfo[]> {
    return [];
  }
}
