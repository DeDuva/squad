/**
 * The one module that names `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK's own `sdk.d.ts` is the source of truth for these shapes; the types
 * here are a deliberately loose structural subset of the parts squad depends
 * on, every one with an index-signature escape hatch. The point is that a
 * field rename upstream surfaces as one `undefined` read inside
 * `normalize.ts` rather than a type error that stops the build or a crash
 * that kills a session — the `SDKMessage` union has ~35 variants and grows.
 *
 * @module adapter/anthropic/agent-sdk
 */

/**
 * A message off the SDK's async iterator.
 *
 * The variants squad reads are spelled out; the trailing catch-all is what
 * keeps unknown types (`system/status`, `rate_limit_event`,
 * `system/thinking_tokens`, and whatever ships next) from being a type error
 * at the switch.
 */
export type AgentSdkMessage =
  | { type: 'system'; subtype?: string; session_id?: string; model?: string; tools?: string[]; [k: string]: unknown }
  | { type: 'stream_event'; event?: unknown; session_id?: string; [k: string]: unknown }
  | { type: 'assistant'; message?: unknown; session_id?: string; [k: string]: unknown }
  | { type: 'user'; message?: unknown; session_id?: string; [k: string]: unknown }
  | {
      type: 'result';
      subtype?: string;
      result?: string;
      is_error?: boolean;
      session_id?: string;
      total_cost_usd?: number;
      usage?: unknown;
      modelUsage?: unknown;
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

/**
 * The handle `query()` returns.
 *
 * It is an `AsyncGenerator`, not a custom object with a `close()` — teardown
 * is `return()`, per the generator protocol. The control methods are only
 * available in streaming-input mode and are typed optional so a fake in a
 * test needn't implement them.
 */
export interface AgentSdkQuery extends AsyncIterable<AgentSdkMessage> {
  return?(value?: unknown): Promise<IteratorResult<AgentSdkMessage>>;
  interrupt?(): Promise<unknown>;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
}

/** The subset of the SDK's module surface squad calls. */
export interface AgentSdkModule {
  query(args: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }): AgentSdkQuery;
  tool?: (...args: unknown[]) => unknown;
  createSdkMcpServer?: (options: unknown) => unknown;
}

let cached: AgentSdkModule | null = null;
let override: AgentSdkModule | null = null;

/**
 * Inject a stand-in module. Tests only — lets the session be driven through
 * its whole lifecycle with no network, no subprocess, and no SDK installed.
 * Pass `null` to restore the real loader.
 */
export function __setAgentSdkForTesting(mod: AgentSdkModule | null): void {
  override = mod;
  cached = null;
}

/**
 * Load the Agent SDK, caching the result.
 *
 * The import is dynamic so that installing the SDK stays optional: a user on
 * the Gemini backend should never be forced to pull down a package (and its
 * platform binary) they will not run.
 */
export async function loadAgentSdk(): Promise<AgentSdkModule> {
  if (override) return override;
  if (cached) return cached;

  try {
    cached = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as AgentSdkModule;
  } catch (err) {
    throw new Error(
      'The Anthropic backend needs @anthropic-ai/claude-agent-sdk, which is not installed. ' +
        'Install it with `npm i @anthropic-ai/claude-agent-sdk`, or switch backends with ' +
        `\`squad config provider gemini\`. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return cached;
}
