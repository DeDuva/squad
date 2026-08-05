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
export interface NormalizedResult {
  /** Whether the turn completed successfully. */
  ok: boolean;
  /** The turn's final text. */
  text: string;
  /** Session-cumulative spend. Diff against the previous result for this turn's cost. */
  cumulativeCostUsd: number | null;
  /** This turn's input tokens. Already per-turn — do NOT diff. */
  inputTokens: number;
  /** This turn's output tokens. Already per-turn — do NOT diff. */
  outputTokens: number;
  model: string | null;
  errorMessage: string | null;
}

/** Read a terminal `result` message. Returns null for anything else. */
export function readResult(m: AgentSdkMessage): NormalizedResult | null {
  if (m.type !== 'result') return null;
  const r = m as Record<string, unknown>;

  const usage = rec(r['usage']);
  const modelUsage = rec(r['modelUsage']);
  // `modelUsage` is keyed by model id; with no fallbacks configured there is
  // exactly one key, and it is the model that actually served the turn.
  const model = modelUsage ? (Object.keys(modelUsage)[0] ?? null) : null;

  const isError = r['is_error'] === true || (r['subtype'] !== undefined && r['subtype'] !== 'success');

  return {
    ok: !isError,
    text: str(r['result']) ?? '',
    cumulativeCostUsd: num(r['total_cost_usd']),
    inputTokens: num(usage?.['input_tokens']) ?? 0,
    outputTokens: num(usage?.['output_tokens']) ?? 0,
    model,
    errorMessage: isError ? (str(r['result']) ?? str(r['subtype']) ?? 'agent run failed') : null,
  };
}
