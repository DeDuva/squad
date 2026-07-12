/**
 * AI SDK-backed session for Squad — implements SquadSession on top of the
 * Vercel AI SDK (`ai` + `@ai-sdk/google` + `@ai-sdk/anthropic`), replacing
 * the hand-rolled Gemini REST/SSE client with a provider-agnostic backend.
 *
 * Preserves GeminiSession's exact hook semantics (tool_call before
 * onPreToolUse, tool_result after onPostToolUse, deny short-circuits the
 * handler, modifiedArgs/modifiedResult are honored) by wrapping every tool's
 * `execute` function rather than relying on any AI SDK step/finish hook —
 * those fire at the wrong granularity for exact per-call event ordering.
 *
 * @module adapter/ai-sdk-session
 */

import { randomUUID } from 'node:crypto';
import { streamText, stepCountIs, tool, jsonSchema, type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionEvent,
  SquadSessionEventHandler,
  SquadSessionEventType,
  SquadMessageOptions,
  SquadTool,
  SquadReasoningEffort,
  SquadSessionHooks,
  SquadPreToolUseHookInput,
  SquadPostToolUseHookInput,
  SquadToolResultObject,
} from './types.js';
import { wrapAiSdkError } from './ai-sdk-errors.js';

export type SquadProviderId = 'google' | 'anthropic';

/** Model ID prefix dispatch: `claude-*` → anthropic, everything else → google. */
export function resolveProvider(model: string): SquadProviderId {
  return model.startsWith('claude-') ? 'anthropic' : 'google';
}

// ---------------------------------------------------------------------------
// Reasoning effort → provider-specific providerOptions
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<SquadReasoningEffort, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

// ---------------------------------------------------------------------------
// Tool schema adaptation — mirrors gemini-client.ts's toGeminiTools branching
// ---------------------------------------------------------------------------

function toAiSdkInputSchema(parameters: SquadTool['parameters']): ReturnType<typeof jsonSchema> {
  if (parameters && typeof (parameters as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    const schema = (parameters as { toJSONSchema(): Record<string, unknown> }).toJSONSchema();
    return jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
  }
  return jsonSchema((parameters ?? { type: 'object', properties: {} }) as Parameters<typeof jsonSchema>[0]);
}

// ---------------------------------------------------------------------------
// AiSdkSession — implements SquadSession
// ---------------------------------------------------------------------------

export class AiSdkSession implements SquadSession {
  readonly sessionId: string;

  private readonly languageModel: LanguageModel;
  private readonly provider: SquadProviderId;
  private readonly model: string;
  private readonly tools: SquadTool[];
  private readonly aiTools: ToolSet;
  private readonly systemPrompt: string | undefined;
  private readonly reasoningEffort: SquadReasoningEffort | undefined;
  private readonly hooks: SquadSessionHooks | undefined;
  private readonly maxToolCallRounds: number;

  private history: ModelMessage[] = [];
  private listeners = new Map<string, Set<SquadSessionEventHandler>>();
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(provider: SquadProviderId, apiKey: string, config: SquadSessionConfig) {
    this.sessionId = config.sessionId ?? randomUUID();
    this.provider = provider;
    this.model = config.model ?? 'gemini-flash-latest';
    this.tools = config.tools ?? [];
    this.hooks = config.hooks;
    this.maxToolCallRounds = config.maxToolCallRounds ?? 10;
    this.reasoningEffort = config.reasoningEffort;

    this.languageModel =
      provider === 'anthropic'
        ? createAnthropic({ apiKey })(this.model)
        : createGoogleGenerativeAI({ apiKey })(this.model);

    // System message
    if (config.systemMessage?.mode === 'replace') {
      this.systemPrompt = config.systemMessage.content;
    } else if (config.systemMessage?.mode === 'append' || !config.systemMessage?.mode) {
      this.systemPrompt = config.systemMessage?.content;
    }

    this.aiTools = this.buildAiSdkTools(this.tools);

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      console.warn(
        '[squad-sdk] mcpServers config is not yet implemented in the AI SDK backend. ' +
        'MCP tool capabilities will not be available in this session.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Event emitter (minimal, synchronous) — identical shape to GeminiSession
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
  // Tool wrapping — reproduces GeminiSession.handleToolCalls's hook sequence
  // per tool call: emit tool_call -> onPreToolUse -> deny-or-handler ->
  // onPostToolUse -> emit tool_result.
  // -------------------------------------------------------------------------

  private buildAiSdkTools(tools: SquadTool[]): ToolSet {
    const aiTools: ToolSet = {};
    for (const squadTool of tools) {
      aiTools[squadTool.name] = tool({
        description: squadTool.description,
        inputSchema: toAiSdkInputSchema(squadTool.parameters),
        execute: async (args: unknown, options: { toolCallId: string }) =>
          this.executeTool(squadTool, args, options.toolCallId),
      });
    }
    return aiTools;
  }

  private async executeTool(squadTool: SquadTool, args: unknown, toolCallId: string): Promise<unknown> {
    this.emit({
      type: 'tool_call',
      toolName: squadTool.name,
      toolCallId,
      arguments: args,
    });

    let result: unknown;

    const preInput: SquadPreToolUseHookInput = {
      timestamp: Date.now(),
      cwd: process.cwd(),
      toolName: squadTool.name,
      toolArgs: args,
    };
    const preOutput = await this.hooks?.onPreToolUse?.(preInput, { sessionId: this.sessionId });

    if (preOutput?.permissionDecision === 'deny') {
      result = {
        textResultForLlm: `Tool use denied: ${preOutput.permissionDecisionReason ?? 'no reason given'}`,
        resultType: 'rejected',
      };
    } else {
      const effectiveArgs = (preOutput?.modifiedArgs ?? args) as Record<string, unknown>;
      try {
        result = await squadTool.handler(effectiveArgs, {
          sessionId: this.sessionId,
          toolCallId,
          toolName: squadTool.name,
          arguments: effectiveArgs,
        });
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const postInput: SquadPostToolUseHookInput = {
      timestamp: Date.now(),
      cwd: process.cwd(),
      toolName: squadTool.name,
      toolArgs: args,
      toolResult: result as SquadToolResultObject,
    };
    const postOutput = await this.hooks?.onPostToolUse?.(postInput, { sessionId: this.sessionId });
    if (postOutput?.modifiedResult !== undefined) {
      result = postOutput.modifiedResult;
    }

    this.emit({
      type: 'tool_result',
      toolName: squadTool.name,
      toolCallId,
      result,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Reasoning effort -> providerOptions
  // -------------------------------------------------------------------------

  private buildProviderOptions(): ProviderOptions | undefined {
    if (!this.reasoningEffort) return undefined;

    if (this.provider === 'anthropic') {
      // Claude 4.x models use adaptive thinking; budgetTokens was removed.
      return { anthropic: { thinking: { type: 'adaptive' } } };
    }

    // Only send thinkingConfig when a budget is explicitly requested —
    // gemini-pro-latest rejects thinkingBudget=0 ("only works in thinking mode").
    return { google: { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[this.reasoningEffort] } } };
  }

  // -------------------------------------------------------------------------
  // sendMessage — drives the AI SDK's built-in multi-step tool loop
  // -------------------------------------------------------------------------

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    this.abortController = new AbortController();
    this.history.push({ role: 'user', content: options.prompt });

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';

    try {
      const result = streamText({
        model: this.languageModel,
        messages: this.history,
        tools: Object.keys(this.aiTools).length > 0 ? this.aiTools : undefined,
        system: this.systemPrompt,
        providerOptions: this.buildProviderOptions(),
        stopWhen: stepCountIs(this.maxToolCallRounds),
        abortSignal: this.abortController.signal,
      });

      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          this.emit({ type: 'message_delta', text: part.text });
        } else if (part.type === 'error') {
          throw wrapAiSdkError(part.error, { sessionId: this.sessionId, model: this.model, operation: 'sendMessage' });
        }
      }

      const usage = await result.usage;
      inputTokens = usage.inputTokens ?? 0;
      outputTokens = usage.outputTokens ?? 0;
      finishReason = await result.finishReason;

      const responseMessages = await result.responseMessages;
      this.history.push(...responseMessages);
    } catch (err) {
      const wrapped = wrapAiSdkError(err, { sessionId: this.sessionId, model: this.model, operation: 'sendMessage' });
      this.emit({ type: 'error', error: wrapped.message });
      throw wrapped;
    } finally {
      this.abortController = null;
    }

    // stopWhen(stepCountIs(N)) stops the loop after N steps regardless of
    // whether the model still wants to call tools — finishReason === 'tool-calls'
    // at this point means the cap was hit mid-loop (mirrors GeminiSession's
    // handleToolCalls throwing once toolCallRound exceeds maxToolCallRounds).
    if (finishReason === 'tool-calls') {
      throw new Error(
        `Tool call depth exceeded maxToolCallRounds (${this.maxToolCallRounds}). ` +
        `This usually means a tool is returning function calls in a loop.`,
      );
    }

    this.emit({ type: 'usage', inputTokens, outputTokens, model: this.model });
    this.emit({ type: 'turn_end' });
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
    return this.history.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : flattenContent(m.content),
    }));
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.closed = true;
    this.listeners.clear();
    this.history = [];
  }
}

/** Flatten a non-string ModelMessage content array to a plain string for getMessages(). */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (part && typeof part === 'object' && 'type' in part) {
        if (part.type === 'text' && 'text' in part) return String((part as { text: unknown }).text);
        if (part.type === 'tool-result' && 'output' in part) return JSON.stringify((part as { output: unknown }).output);
      }
      return '';
    })
    .join('');
}
