/**
 * Defensive readers for Agent SDK messages.
 *
 * Every field access squad makes against an SDK message lives here, and every
 * reader returns `null`/a default rather than throwing. That is the whole
 * design: the exact shapes were verified against `sdk.d.ts` and a live run,
 * but they are upstream's to change, and the failure mode for a rename should
 * be one wrong number in a usage event — not a dead session.
 *
 * @module adapter/anthropic/normalize
 */

import type { AgentSdkMessage } from './agent-sdk.js';

/** Narrow an unknown to an indexable record without asserting anything about it. */
function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Incremental assistant text from a partial-message event.
 *
 * Verified path: `stream_event` → `event.type === 'content_block_delta'` →
 * `event.delta.type === 'text_delta'` → `event.delta.text`. Only emitted when
 * the session asked for `includePartialMessages`.
 */
export function readTextDelta(m: AgentSdkMessage): string | null {
  if (m.type !== 'stream_event') return null;
  const event = rec((m as Record<string, unknown>)['event']);
  if (!event || event['type'] !== 'content_block_delta') return null;
  const delta = rec(event['delta']);
  if (!delta || delta['type'] !== 'text_delta') return null;
  return str(delta['text']);
}

/**
 * Text blocks from a complete assistant message.
 *
 * The payload is nested — `message.message.content` — because the SDK wraps
 * the raw API message. Verified live; the API-reference summary that says
 * `content` sits at the top level is wrong.
 */
export function readAssistantText(m: AgentSdkMessage): string[] {
  if (m.type !== 'assistant') return [];
  const inner = rec((m as Record<string, unknown>)['message']);
  const content = inner?.['content'];
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    const b = rec(block);
    if (b?.['type'] === 'text') {
      const t = str(b['text']);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Tool calls from a complete `assistant` message, with their full arguments.
 *
 * The streaming readers below only fire when `includePartialMessages` is on.
 * That made tool identity a function of an unrelated setting: with streaming
 * off, every tool call reached consumers nameless and argument-less, so a
 * trajectory recorded seven anonymous tools — which looks like data and is not.
 * The complete assistant message always carries the same blocks, fully formed.
 */
export function readAssistantToolUses(
  m: AgentSdkMessage,
): { id: string | null; name: string; input: Record<string, unknown> }[] {
  if (m.type !== 'assistant') return [];
  const inner = rec((m as Record<string, unknown>)['message']);
  const content = inner?.['content'];
  if (!Array.isArray(content)) return [];

  const out: { id: string | null; name: string; input: Record<string, unknown> }[] = [];
  for (const block of content) {
    const b = rec(block);
    if (b?.['type'] !== 'tool_use') continue;
    const name = str(b['name']);
    if (!name) continue;
    out.push({ id: str(b['id']), name, input: rec(b['input']) ?? {} });
  }
  return out;
}

/** A tool call beginning, from the partial-message stream. */
export function readToolUseStart(m: AgentSdkMessage): { name: string; id?: string } | null {
  if (m.type !== 'stream_event') return null;
  const event = rec((m as Record<string, unknown>)['event']);
  if (!event || event['type'] !== 'content_block_start') return null;
  const block = rec(event['content_block']);
  if (!block || block['type'] !== 'tool_use') return null;

  const name = str(block['name']);
  if (!name) return null;
  const id = str(block['id']);
  return id === null ? { name } : { name, id };
}

/**
 * The `content_block_start` index of a tool_use block, so its argument deltas
 * can be keyed back to it.
 */
export function readToolUseStartIndex(m: AgentSdkMessage): number | null {
  if (m.type !== 'stream_event') return null;
  const event = rec((m as Record<string, unknown>)['event']);
  if (!event || event['type'] !== 'content_block_start') return null;
  const block = rec(event['content_block']);
  if (!block || block['type'] !== 'tool_use') return null;
  return num(event['index']);
}

/**
 * A fragment of a tool call's arguments, from the partial-message stream.
 *
 * `content_block_start` announces a tool_use block with its name and id but an
 * empty input; the arguments follow as `input_json_delta` pieces of a JSON
 * string. A single fragment is rarely valid JSON on its own, so this returns
 * the piece and its block index and leaves joining to the caller.
 */
export function readToolInputDelta(m: AgentSdkMessage): { index: number; fragment: string } | null {
  if (m.type !== 'stream_event') return null;
  const event = rec((m as Record<string, unknown>)['event']);
  if (!event || event['type'] !== 'content_block_delta') return null;
  const delta = rec(event['delta']);
  if (!delta || delta['type'] !== 'input_json_delta') return null;
  const fragment = str(delta['partial_json']);
  const index = num(event['index']);
  return fragment === null || index === null ? null : { index, fragment };
}

/** The index of any `content_block_stop`, so a held-open block can be closed. */
export function readContentBlockStopIndex(m: AgentSdkMessage): number | null {
  if (m.type !== 'stream_event') return null;
  const event = rec((m as Record<string, unknown>)['event']);
  if (!event || event['type'] !== 'content_block_stop') return null;
  return num(event['index']);
}

/**
 * Tool results, from the `user` message the SDK synthesizes once a tool has run.
 *
 * These were previously ignored, which left `tool_call` with no completion: an
 * observer could see a tool was *requested* and never learn whether it
 * succeeded, failed, or was denied. Content is flattened to a string because
 * consumers use it for display and provenance, not control flow.
 */
export function readToolResults(
  m: AgentSdkMessage,
): { toolCallId: string; content: string; isError: boolean }[] {
  if (m.type !== 'user') return [];
  const inner = rec((m as Record<string, unknown>)['message']);
  const content = inner?.['content'];
  if (!Array.isArray(content)) return [];

  const out: { toolCallId: string; content: string; isError: boolean }[] = [];
  for (const block of content) {
    const b = rec(block);
    if (b?.['type'] !== 'tool_result') continue;
    const toolCallId = str(b['tool_use_id']);
    if (!toolCallId) continue;
    out.push({
      toolCallId,
      content: flattenToolResultContent(b['content']),
      isError: b['is_error'] === true,
    });
  }
  return out;
}

/** Tool result content is either a string or a list of blocks; flatten both to text. */
function flattenToolResultContent(value: unknown): string {
  const direct = str(value);
  if (direct !== null) return direct;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const b = rec(block);
      return b?.['type'] === 'text' ? (str(b['text']) ?? '') : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/** The session id, which every message carries. */
export function readSessionId(m: AgentSdkMessage): string | null {
  return str((m as Record<string, unknown>)['session_id']);
}

/** Metadata from a `system`/`init` message. Re-emitted once per turn, not once per session. */
export function readInit(m: AgentSdkMessage): { model: string | null; tools: string[] } | null {
  if (m.type !== 'system' || (m as Record<string, unknown>)['subtype'] !== 'init') return null;
  const tools = (m as Record<string, unknown>)['tools'];
  return {
    model: str((m as Record<string, unknown>)['model']),
    tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [],
  };
}

/**
 * A turn's terminal `result` message, normalized.
 *
 * The two usage fields have DIFFERENT shapes, which is easy to get wrong and
 * silently mis-bills either way. Established by running short → long → short
 * turns and watching which numbers could decrease:
 *
 *   turn 1: out=114  cost=0.001301
 *   turn 2: out=304  cost=0.003002   <- longest turn
 *   turn 3: out=55   cost=0.003708   <- shortest turn, yet highest cost
 *
 * Output tokens track the actual work and fall again on turn 3, so they are
 * per-turn. Cost never decreases, so it is session-cumulative. Two data
 * points are not enough to tell these apart — both readings fit a run where
 * every turn happens to grow.
 */
/** Per-model usage for one turn, as `modelUsage` reports it. */
export interface NormalizedModelUsage {
  /** Unpinned alias where the SDK provides one, else the key it was filed under. */
  model: string;
  /** Uncached input tokens only — see {@link NormalizedResult.inputTokens}. */
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface NormalizedResult {
  /** Whether the turn completed successfully. */
  ok: boolean;
  /** The turn's final text. */
  text: string;
  /** Session-cumulative spend. Diff against the previous result for this turn's cost. */
  cumulativeCostUsd: number | null;
  /**
   * Every input token the turn processed — uncached **plus** cache reads and
   * cache writes.
   *
   * `usage.input_tokens` alone counts only the uncached remainder, and the
   * Agent SDK caches aggressively, so it is a small fraction of the real
   * prompt: a measured turn reported `input_tokens: 2` against
   * `cache_creation_input_tokens: 15454`. Reading the bare field under-counted
   * by ~7000x, which is worse than not measuring — it looked like a number.
   * The breakdown is preserved below, since cache reads and writes are priced
   * differently and collapsing them would trade one wrong number for another.
   */
  inputTokens: number;
  /** Input tokens served from cache (cheapest tier). */
  cacheReadInputTokens: number;
  /** Input tokens written to cache (priced above uncached). */
  cacheCreationInputTokens: number;
  /** This turn's output tokens. Already per-turn — do NOT diff. */
  outputTokens: number;
  /**
   * The model that did the work: the one with the most output tokens.
   *
   * `modelUsage` routinely carries more than one model — the SDK bills small
   * auxiliary calls alongside the one you configured. Taking the first key
   * meant a Sonnet session was recorded against
   * `claude-haiku-4-5-20251001`, attributing the turn to a model that wrote
   * 12 tokens of the 96 produced. Output tokens are the tiebreak because they
   * track the work rather than the context.
   */
  model: string | null;
  /** Every model that participated, for attribution the single `model` cannot carry. */
  models: NormalizedModelUsage[];
  /** Wall-clock for the turn, per the SDK. */
  durationMs: number | null;
  /** Time spent in API calls, which excludes local tool execution. */
  apiDurationMs: number | null;
  /** Time to first token. */
  ttftMs: number | null;
  /** Model round-trips the SDK made for this turn. */
  numTurns: number | null;
  errorMessage: string | null;
}

/** Read a terminal `result` message. Returns null for anything else. */
export function readResult(m: AgentSdkMessage): NormalizedResult | null {
  if (m.type !== 'result') return null;
  const r = m as Record<string, unknown>;

  const usage = rec(r['usage']);
  const models = readModelUsage(rec(r['modelUsage']));

  // The model that produced the most output did the work. Ties and an empty
  // map both fall back to the first entry, which is the old behaviour and is
  // correct whenever there is only one model.
  const primary = models.reduce<NormalizedModelUsage | null>(
    (best, m) => (best === null || m.outputTokens > best.outputTokens ? m : best),
    null,
  );

  const uncachedIn = num(usage?.['input_tokens']) ?? 0;
  const cacheRead = num(usage?.['cache_read_input_tokens']) ?? 0;
  const cacheCreation = num(usage?.['cache_creation_input_tokens']) ?? 0;

  const isError = r['is_error'] === true || (r['subtype'] !== undefined && r['subtype'] !== 'success');

  return {
    ok: !isError,
    text: str(r['result']) ?? '',
    cumulativeCostUsd: num(r['total_cost_usd']),
    inputTokens: uncachedIn + cacheRead + cacheCreation,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    outputTokens: num(usage?.['output_tokens']) ?? 0,
    model: primary?.model ?? null,
    models,
    durationMs: num(r['duration_ms']),
    apiDurationMs: num(r['duration_api_ms']),
    ttftMs: num(r['ttft_ms']),
    numTurns: num(r['num_turns']),
    errorMessage: isError ? (str(r['result']) ?? str(r['subtype']) ?? 'agent run failed') : null,
  };
}

/**
 * Flatten `modelUsage` into a list.
 *
 * Prefers each entry's `canonicalModel` over the key it is filed under: the key
 * is a dated snapshot (`claude-haiku-4-5-20251001`) while the canonical form is
 * the alias that tracks releases. Recording the key would put a pinned id into
 * telemetry that no configuration asked for.
 */
function readModelUsage(modelUsage: Record<string, unknown> | null): NormalizedModelUsage[] {
  if (!modelUsage) return [];
  const out: NormalizedModelUsage[] = [];
  for (const [key, raw] of Object.entries(modelUsage)) {
    const entry = rec(raw);
    out.push({
      model: str(entry?.['canonicalModel']) ?? key,
      uncachedInputTokens: num(entry?.['inputTokens']) ?? 0,
      cacheReadInputTokens: num(entry?.['cacheReadInputTokens']) ?? 0,
      cacheCreationInputTokens: num(entry?.['cacheCreationInputTokens']) ?? 0,
      outputTokens: num(entry?.['outputTokens']) ?? 0,
      costUsd: num(entry?.['costUSD']),
    });
  }
  return out;
}
