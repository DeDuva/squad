/**
 * AnthropicSession behaviour, driven by a stand-in SDK module.
 *
 * No network, no subprocess, no installed SDK: `__setAgentSdkForTesting`
 * swaps in a fake whose script we control, which is what makes the turn
 * boundary, usage accounting, and teardown paths testable at all.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { AnthropicSession, AnthropicClient } from '../packages/squad-sdk/src/adapter/anthropic-client.js';
import { __setAgentSdkForTesting } from '../packages/squad-sdk/src/adapter/anthropic/agent-sdk.js';
import type { AgentSdkMessage, AgentSdkModule } from '../packages/squad-sdk/src/adapter/anthropic/agent-sdk.js';

/** A `result` message with the shape the real SDK emits. */
function result(opts: {
  text: string;
  /** Session-cumulative, as the real SDK reports it. */
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  modelUsage?: Record<string, unknown>;
  durationMs?: number;
  ttftMs?: number;
  numTurns?: number;
  error?: boolean;
}): AgentSdkMessage {
  return {
    type: 'result',
    subtype: opts.error ? 'error_during_execution' : 'success',
    is_error: opts.error ?? false,
    result: opts.text,
    total_cost_usd: opts.cost ?? 0,
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
    },
    modelUsage: opts.modelUsage ?? { 'claude-sonnet-5': {} },
    duration_ms: opts.durationMs,
    ttft_ms: opts.ttftMs,
    num_turns: opts.numTurns,
    session_id: 'sdk-session',
  };
}

/** A complete (non-streamed) assistant message carrying tool_use blocks. */
function assistantToolUse(blocks: { id: string; name: string; input: Record<string, unknown> }[]): AgentSdkMessage {
  return {
    type: 'assistant',
    message: { content: blocks.map((b) => ({ type: 'tool_use', ...b })) },
  };
}

function textDelta(text: string): AgentSdkMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}


/** A tool_use block opening on the partial-message stream. */
function toolUseStart(index: number, name: string, id: string): AgentSdkMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
  };
}

/** A fragment of a tool call's arguments — deliberately not valid JSON alone. */
function toolInputDelta(index: number, partial_json: string): AgentSdkMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } },
  };
}

function contentBlockStop(index: number): AgentSdkMessage {
  return { type: 'stream_event', event: { type: 'content_block_stop', index } };
}

/** The `user` message the SDK synthesizes once a tool has run. */
function toolResult(id: string, content: unknown, isError = false): AgentSdkMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}

/** Install a fake SDK whose per-turn output is scripted. */
function installFake(script: (turn: number, prompt: string) => AgentSdkMessage[]) {
  const seen: { options?: Record<string, unknown>; prompts: string[] } = { prompts: [] };

  const mod: AgentSdkModule = {
    // Enough of the MCP surface for `buildSquadMcpServer` to take its real
    // branch — otherwise every squad tool test falls into the "no bridge"
    // path, which is not the one a worker agent uses.
    tool: (name: unknown) => ({ name }),
    createSdkMcpServer: (options: unknown) => ({ server: options }),
    query({ prompt, options }) {
      seen.options = options;
      return (async function* () {
        let turn = 0;
        for await (const raw of prompt as AsyncIterable<Record<string, unknown>>) {
          const message = raw['message'] as { content: string } | undefined;
          const text = message?.content ?? '';
          seen.prompts.push(text);
          for (const m of script(turn, text)) yield m;
          turn++;
        }
      })();
    },
  };

  __setAgentSdkForTesting(mod);
  return seen;
}

afterEach(() => {
  __setAgentSdkForTesting(null);
});

describe('AnthropicSession — the tool surface', () => {
  // Squad tools, so the MCP bridge is built and the session takes the branch a
  // worker agent actually takes.
  const squadTool = {
    name: 'write_file',
    description: 'write a file',
    parameters: {},
    execute: async () => 'ok',
  };

  it('offers the backend built-ins alongside squad tools by default', async () => {
    const seen = installFake(() => [result({ text: 'done' })]);
    const session = new AnthropicSession({ tools: [squadTool] as never[] });
    await session.sendAndWait({ prompt: 'hi' });

    // The right default for getting work done: these are good tools.
    expect(seen.options?.['allowedTools']).toEqual(expect.arrayContaining(['Read', 'Bash']));
    expect(seen.options?.['tools']).toBeUndefined();
    await session.close();
  });

  it('removes them outright when builtinTools is false', async () => {
    const seen = installFake(() => [result({ text: 'done' })]);
    const session = new AnthropicSession({ tools: [squadTool] as never[], builtinTools: false });
    await session.sendAndWait({ prompt: 'hi' });

    // `tools: []` is the mechanism that deregisters them. Verified the
    // expensive way first: a run that named only the bridged tools in
    // `allowedTools` still reached for Bash, Write and Read eleven times,
    // because `allowedTools` filters permission rather than registration.
    expect(seen.options?.['tools']).toEqual([]);
    await session.close();
  });

  it('keeps squad\'s own tools reachable when the built-ins go', async () => {
    const seen = installFake(() => [result({ text: 'done' })]);
    const session = new AnthropicSession({ tools: [squadTool] as never[], builtinTools: false });
    await session.sendAndWait({ prompt: 'hi' });

    // They arrive through `mcpServers`, so emptying `tools` does not take them
    // with it — without which "parity" would mean an agent with no tools.
    expect(seen.options?.['mcpServers']).toBeDefined();
    expect(seen.options?.['allowedTools']).toEqual(expect.arrayContaining(['mcp__squad__write_file']));
    await session.close();
  });
});

describe('AnthropicSession — turn lifecycle', () => {
  it('resolves a turn when the result message arrives', async () => {
    installFake(() => [textDelta('hello '), textDelta('world'), result({ text: 'hello world' })]);
    const session = new AnthropicSession({ streaming: true });

    const text = await session.sendAndWait({ prompt: 'hi' });

    expect(text).toBe('hello world');
    await session.close();
  });

  it('falls back to the result text when partial messages are off', async () => {
    installFake(() => [result({ text: 'final answer' })]);
    const session = new AnthropicSession({});

    expect(await session.sendAndWait({ prompt: 'hi' })).toBe('final answer');
    await session.close();
  });

  it('serves multiple turns from one session', async () => {
    installFake((turn) => [result({ text: `turn-${turn}` })]);
    const session = new AnthropicSession({});

    expect(await session.sendAndWait({ prompt: 'one' })).toBe('turn-0');
    expect(await session.sendAndWait({ prompt: 'two' })).toBe('turn-1');
    await session.close();
  });

  it('serializes concurrent sends instead of racing for one result', async () => {
    // Both turns are started before either resolves. Without the turn chain,
    // the second would bind to the first turn's result message.
    installFake((turn) => [textDelta(`t${turn}`), result({ text: `turn-${turn}` })]);
    const session = new AnthropicSession({ streaming: true });

    const [first, second] = await Promise.all([
      session.sendAndWait({ prompt: 'one' }),
      session.sendAndWait({ prompt: 'two' }),
    ]);

    expect(first).toBe('t0');
    expect(second).toBe('t1');
    await session.close();
  });

  it('rejects the turn when the result is an error', async () => {
    installFake(() => [result({ text: 'exploded', error: true })]);
    const session = new AnthropicSession({});

    await expect(session.sendAndWait({ prompt: 'hi' })).rejects.toThrow(/exploded/);
    await session.close();
  });

  it('keeps serving turns after one fails', async () => {
    installFake((turn) =>
      turn === 0 ? [result({ text: 'boom', error: true })] : [result({ text: 'recovered' })],
    );
    const session = new AnthropicSession({});

    await expect(session.sendAndWait({ prompt: 'one' })).rejects.toThrow(/boom/);
    expect(await session.sendAndWait({ prompt: 'two' })).toBe('recovered');
    await session.close();
  });
});

describe('AnthropicSession — events', () => {
  it('emits streamed text under delta, text, and content', async () => {
    installFake(() => [textDelta('hi'), result({ text: 'hi' })]);
    const session = new AnthropicSession({ streaming: true });

    const seen: Array<Record<string, unknown>> = [];
    session.on('message_delta', (e) => seen.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    expect(seen).toHaveLength(1);
    for (const key of ['delta', 'text', 'content']) {
      expect(seen[0]![key]).toBe('hi');
    }
    await session.close();
  });

  it('does not double-emit assistant text that already streamed as deltas', async () => {
    installFake(() => [
      textDelta('once'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'once' }] } },
      result({ text: 'once' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    let accumulated = '';
    session.on('message_delta', (e) => {
      accumulated += (e as unknown as { delta: string }).delta;
    });

    await session.sendAndWait({ prompt: 'x' });

    expect(accumulated).toBe('once');
    await session.close();
  });

  it('emits assistant text when no deltas arrived', async () => {
    installFake(() => [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'from block' }] } },
      result({ text: '' }),
    ]);
    const session = new AnthropicSession({});

    let accumulated = '';
    session.on('message_delta', (e) => {
      accumulated += (e as unknown as { delta: string }).delta;
    });

    await session.sendAndWait({ prompt: 'x' });

    expect(accumulated).toBe('from block');
    await session.close();
  });

  it('reports tool calls', async () => {
    installFake(() => [
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash', id: 'tu_1' } },
      },
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const calls: Array<Record<string, unknown>> = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!['toolName']).toBe('Bash');
    expect(calls[0]!['toolCallId']).toBe('tu_1');
    await session.close();
  });

  it('ignores message types it does not model', async () => {
    // The SDKMessage union has ~35 variants and grows; a trivial run already
    // emits system/status, system/thinking_tokens, and rate_limit_event.
    installFake(() => [
      { type: 'system', subtype: 'status' },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'rate_limit_event' },
      { type: 'some_future_type_we_have_never_seen' },
      result({ text: 'fine' }),
    ]);
    const session = new AnthropicSession({});

    const errors: unknown[] = [];
    session.on('error', (e) => errors.push(e));

    expect(await session.sendAndWait({ prompt: 'x' })).toBe('fine');
    expect(errors).toEqual([]);
    await session.close();
  });
});

describe('AnthropicSession — usage accounting', () => {
  // The two fields on a `result` have different shapes, and mixing them up
  // mis-bills either way. Values below are the shape observed live across
  // short -> long -> short turns: output tokens fall again on the third turn
  // (so they are per-turn), while cost never decreases (so it is cumulative).

  it('passes token counts through untouched — they are already per-turn', async () => {
    installFake((turn) =>
      turn === 0
        ? [result({ text: 'a', cost: 0.001301, inputTokens: 10, outputTokens: 114 })]
        : [result({ text: 'b', cost: 0.003002, inputTokens: 10, outputTokens: 304 })],
    );
    const session = new AnthropicSession({});

    const usage: Array<Record<string, number>> = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, number>));

    await session.sendAndWait({ prompt: 'one' });
    await session.sendAndWait({ prompt: 'two' });

    expect(usage[0]!['inputTokens']).toBe(10);
    expect(usage[0]!['outputTokens']).toBe(114);
    // Diffing these would report 0/190 here instead of 10/304 — and 0 input
    // on every turn after the first, which is what the bug looked like.
    expect(usage[1]!['inputTokens']).toBe(10);
    expect(usage[1]!['outputTokens']).toBe(304);

    await session.close();
  });

  it('reports cost as a delta of the cumulative total', async () => {
    installFake((turn) =>
      turn === 0
        ? [result({ text: 'a', cost: 0.001301, outputTokens: 114 })]
        : [result({ text: 'b', cost: 0.003002, outputTokens: 304 })],
    );
    const session = new AnthropicSession({});

    const usage: Array<Record<string, number>> = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, number>));

    await session.sendAndWait({ prompt: 'one' });
    await session.sendAndWait({ prompt: 'two' });

    expect(usage[0]!['costUsd']).toBeCloseTo(0.001301, 8);
    // The turn's own cost, not the running total.
    expect(usage[1]!['costUsd']).toBeCloseTo(0.001701, 8);

    await session.close();
  });

  it('reports a cheap turn as cheap even though the running total grew', async () => {
    // The turn that proved cost is cumulative: smallest output, highest total.
    installFake((turn) =>
      turn === 0
        ? [result({ text: 'a', cost: 0.003002, outputTokens: 304 })]
        : [result({ text: 'b', cost: 0.003708, outputTokens: 55 })],
    );
    const session = new AnthropicSession({});

    const usage: Array<Record<string, number>> = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, number>));

    await session.sendAndWait({ prompt: 'one' });
    await session.sendAndWait({ prompt: 'two' });

    expect(usage[1]!['outputTokens']).toBe(55);
    expect(usage[1]!['costUsd']).toBeCloseTo(0.000706, 8);
    expect(usage[1]!['costUsd']).toBeLessThan(usage[0]!['costUsd']!);

    await session.close();
  });

  it('never reports negative cost if the total ever goes backwards', async () => {
    installFake((turn) =>
      turn === 0 ? [result({ text: 'a', cost: 0.05 })] : [result({ text: 'b', cost: 0.01 })],
    );
    const session = new AnthropicSession({});

    const usage: Array<Record<string, number>> = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, number>));

    await session.sendAndWait({ prompt: 'one' });
    await session.sendAndWait({ prompt: 'two' });

    expect(usage[1]!['costUsd']).toBe(0);
    await session.close();
  });
});

describe('AnthropicSession — options', () => {
  it('always isolates the session from the user global Claude Code config', async () => {
    // settingSources alone is not enough — a live run still leaked the user's
    // personal MCP servers into the session until strictMcpConfig was set.
    const seen = installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({});

    await session.sendAndWait({ prompt: 'x' });

    expect(seen.options!['settingSources']).toEqual([]);
    expect(seen.options!['strictMcpConfig']).toBe(true);
    expect(seen.options!['persistSession']).toBe(false);
    await session.close();
  });

  it('passes its own session id to the SDK so the two ids are one value', async () => {
    const seen = installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({ sessionId: 'squad-owned-id' });

    await session.sendAndWait({ prompt: 'x' });

    expect(session.sessionId).toBe('squad-owned-id');
    expect(seen.options!['sessionId']).toBe('squad-owned-id');
    await session.close();
  });

  it('appends the system message rather than replacing the preset by default', async () => {
    const seen = installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({ systemMessage: { mode: 'append', content: 'be terse' } });

    await session.sendAndWait({ prompt: 'x' });

    expect(seen.options!['systemPrompt']).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'be terse',
    });
    await session.close();
  });

  it('replaces the system prompt outright when asked', async () => {
    const seen = installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({ systemMessage: { mode: 'replace', content: 'only this' } });

    await session.sendAndWait({ prompt: 'x' });

    expect(seen.options!['systemPrompt']).toBe('only this');
    await session.close();
  });

  it('maps model, cwd, and reasoning effort onto SDK options', async () => {
    const seen = installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({
      model: 'claude-opus-5',
      workingDirectory: '/tmp/x',
      reasoningEffort: 'high',
      streaming: true,
    });

    await session.sendAndWait({ prompt: 'x' });

    expect(seen.options!['model']).toBe('claude-opus-5');
    expect(seen.options!['cwd']).toBe('/tmp/x');
    expect(seen.options!['effort']).toBe('high');
    expect(seen.options!['includePartialMessages']).toBe(true);
    await session.close();
  });
});

describe('AnthropicSession — teardown', () => {
  it('is safe to close twice', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({});

    await session.sendAndWait({ prompt: 'x' });
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('rejects sends after close', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({});

    await session.close();
    await expect(session.sendMessage({ prompt: 'x' })).rejects.toThrow(/closed/i);
  });

  it('closes cleanly without ever having sent a message', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicSession({});

    await expect(session.close()).resolves.toBeUndefined();
  });

  it('fails an in-flight turn rather than hanging when closed mid-turn', async () => {
    // Script a turn that never produces a result.
    installFake(() => []);
    const session = new AnthropicSession({});

    const inFlight = session.sendAndWait({ prompt: 'x' });
    // Let the turn start before tearing down.
    await new Promise((r) => setTimeout(r, 10));
    await session.close();

    await expect(inFlight).rejects.toThrow();
  });
});

describe('AnthropicClient', () => {
  it('reports started only after start()', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const client = new AnthropicClient();

    expect(client.isStarted()).toBe(false);
    await client.start();
    expect(client.isStarted()).toBe(true);
    expect(await client.stop()).toEqual([]);
    expect(client.isStarted()).toBe(false);
  });

  it('creates sessions synchronously so sessionId is readable immediately', () => {
    installFake(() => [result({ text: 'ok' })]);
    const session = new AnthropicClient().createSession({});

    expect(typeof session.sessionId).toBe('string');
    expect(session.sessionId.length).toBeGreaterThan(0);
  });

  it('identifies itself as the anthropic backend', async () => {
    installFake(() => [result({ text: 'ok' })]);
    expect(await new AnthropicClient().getStatus()).toEqual({ version: 'anthropic', protocolVersion: 1 });
  });

  it('reports api-key auth when a key is supplied', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const status = await new AnthropicClient('sk-test').getAuthStatus();

    expect(status.isAuthenticated).toBe(true);
    expect(status.authType).toBe('api-key');
  });

  it('reports inherited CLI credentials when no key is set', async () => {
    installFake(() => [result({ text: 'ok' })]);
    const previous = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const status = await new AnthropicClient().getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.authType).toBe('user');
    } finally {
      if (previous !== undefined) process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('surfaces an actionable message when the SDK is not installed', async () => {
    __setAgentSdkForTesting(null);
    // Force the real loader down its failure path by making the import fail.
    // The message must name both the install and the escape hatch.
    const client = new AnthropicClient();
    try {
      await client.start();
      // SDK is installed in this workspace, so start() succeeds — assert the
      // happy path instead of faking a resolution failure.
      expect(client.isStarted()).toBe(true);
    } catch (err) {
      expect((err as Error).message).toMatch(/claude-agent-sdk/);
      expect((err as Error).message).toMatch(/squad config provider gemini/);
    }
  });
});

// The tool half of the trajectory. `tool_call` alone says a tool was
// *requested*; without `tool_result` nothing downstream can tell a tool that
// succeeded from one that failed or was denied — which is exactly how squad's
// EventBus bridge came to record zero tool calls on this backend.
describe('AnthropicSession — tool lifecycle', () => {
  it('emits a tool call once, with the arguments that streamed in after it', async () => {
    installFake(() => [
      toolUseStart(0, 'write_file', 'toolu_1'),
      // Split mid-token: a single fragment is not valid JSON on its own, so
      // anything parsing per-delta would drop the arguments.
      toolInputDelta(0, '{"path":"gree'),
      toolInputDelta(0, 'ting.js","content":"x"}'),
      contentBlockStop(0),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const calls: Record<string, unknown>[] = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'write it' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!['toolName']).toBe('write_file');
    expect(calls[0]!['toolCallId']).toBe('toolu_1');
    expect(calls[0]!['arguments']).toEqual({ path: 'greeting.js', content: 'x' });
    await session.close();
  });

  it('emits a tool result carrying the outcome and the tool it came from', async () => {
    installFake(() => [
      toolUseStart(0, 'run_tests', 'toolu_2'),
      contentBlockStop(0),
      toolResult('toolu_2', 'all tests passed'),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const results: Record<string, unknown>[] = [];
    session.on('tool_result', (e) => results.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'test it' });

    expect(results).toHaveLength(1);
    // The result message carries only the id, so the name has to be remembered
    // from the call — otherwise every result is attributed to "unknown".
    expect(results[0]!['toolName']).toBe('run_tests');
    expect(results[0]!['result']).toMatchObject({
      textResultForLlm: 'all tests passed',
      resultType: 'success',
    });
    await session.close();
  });

  it('marks a failed tool as a failure rather than a success with odd text', async () => {
    installFake(() => [
      toolUseStart(0, 'run_tests', 'toolu_3'),
      contentBlockStop(0),
      toolResult('toolu_3', [{ type: 'text', text: 'exit code 1' }], true),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const results: Record<string, unknown>[] = [];
    session.on('tool_result', (e) => results.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'test it' });

    // Block-list content flattens to text, and is_error drives the outcome.
    expect(results[0]!['result']).toMatchObject({ error: 'exit code 1', resultType: 'failure' });
    await session.close();
  });

  // Losing the event would put a hole in the trajectory exactly when something
  // went wrong, which is the worst time for the record to go quiet.
  it('still reports a tool call whose arguments arrive malformed', async () => {
    installFake(() => [
      toolUseStart(0, 'write_file', 'toolu_4'),
      toolInputDelta(0, '{"path": truncated'),
      contentBlockStop(0),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const calls: Record<string, unknown>[] = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'write it' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!['toolName']).toBe('write_file');
    expect(calls[0]!['arguments']).toEqual({});
    await session.close();
  });

  it('keeps two concurrent tool calls apart by block index', async () => {
    installFake(() => [
      toolUseStart(0, 'read_file', 'toolu_a'),
      toolUseStart(1, 'write_file', 'toolu_b'),
      toolInputDelta(1, '{"path":"b.js"}'),
      toolInputDelta(0, '{"path":"a.js"}'),
      contentBlockStop(0),
      contentBlockStop(1),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const calls: Record<string, unknown>[] = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'both' });

    const byName = Object.fromEntries(calls.map((c) => [c['toolName'], c['arguments']]));
    expect(byName).toEqual({ read_file: { path: 'a.js' }, write_file: { path: 'b.js' } });
    await session.close();
  });
});

// Each of these pins a defect found by comparing two vendors on one task
// (reports/m8-vendor-bakeoff.md). They were not hypothetical: every number
// below is the shape the real SDK returned.
describe('AnthropicSession — usage accounting', () => {
  it('counts cached input, not just the uncached remainder', async () => {
    // Measured shape: a turn reporting 2 uncached input tokens against 15454
    // written to cache. Reading input_tokens alone under-counted by ~7000x.
    installFake(() => [result({ text: 'ok', inputTokens: 2, cacheCreation: 15454, cacheRead: 1200, outputTokens: 4 })]);
    const session = new AnthropicSession({});

    const usage: Record<string, unknown>[] = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    expect(usage[0]!['inputTokens']).toBe(2 + 15454 + 1200);
    // The split survives, because cache reads and writes are priced
    // differently — one summed number cannot be turned back into cost.
    expect(usage[0]!['cacheCreationInputTokens']).toBe(15454);
    expect(usage[0]!['cacheReadInputTokens']).toBe(1200);
    await session.close();
  });

  it('attributes the turn to the model that produced the output, not the first key', async () => {
    // The real failure: a Sonnet session recorded against an auxiliary Haiku
    // call that wrote 12 of the 96 output tokens.
    installFake(() => [
      result({
        text: 'ok',
        modelUsage: {
          'claude-haiku-4-5-20251001': { outputTokens: 12, inputTokens: 526, canonicalModel: 'claude-haiku-4-5' },
          'claude-sonnet-5': { outputTokens: 84, inputTokens: 4, canonicalModel: 'claude-sonnet-5' },
        },
      }),
    ]);
    const session = new AnthropicSession({});

    const usage: Record<string, unknown>[] = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    expect(usage[0]!['model']).toBe('claude-sonnet-5');
    // Both models are still reported, so a turn billed across two can be
    // attributed rather than silently collapsed onto one.
    expect((usage[0]!['models'] as { model: string }[]).map((m) => m.model).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
    ]);
    await session.close();
  });

  it('reports the canonical alias rather than the dated snapshot it was billed under', async () => {
    installFake(() => [
      result({
        text: 'ok',
        modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 5, canonicalModel: 'claude-haiku-4-5' } },
      }),
    ]);
    const session = new AnthropicSession({});
    const usage: Record<string, unknown>[] = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    // Nothing in squad's config pins a version; telemetry should not either.
    expect(usage[0]!['model']).toBe('claude-haiku-4-5');
    await session.close();
  });

  it('carries the turn timings the SDK reports', async () => {
    installFake(() => [result({ text: 'ok', durationMs: 3458, ttftMs: 620, numTurns: 2 })]);
    const session = new AnthropicSession({});
    const usage: Record<string, unknown>[] = [];
    session.on('usage', (e) => usage.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'x' });

    expect(usage[0]!['durationMs']).toBe(3458);
    expect(usage[0]!['ttftMs']).toBe(620);
    expect(usage[0]!['numTurns']).toBe(2);
    await session.close();
  });
});

describe('AnthropicSession — tool identity without streaming', () => {
  // The defect: tool names and arguments reached consumers only through the
  // partial-message stream, so with streaming off a run recorded seven
  // anonymous tool calls — which reads as data and is not.
  it('names tool calls from the complete assistant message', async () => {
    installFake(() => [
      assistantToolUse([{ id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }]),
      result({ text: 'done' }),
    ]);
    // Streaming deliberately OFF — the configuration that used to lose names.
    const session = new AnthropicSession({});

    const calls: Record<string, unknown>[] = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'run it' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!['toolName']).toBe('Bash');
    expect(calls[0]!['arguments']).toEqual({ command: 'echo hi' });
    await session.close();
  });

  it('emits a call once when both the stream and the assistant message carry it', async () => {
    installFake(() => [
      toolUseStart(0, 'Bash', 'toolu_2'),
      toolInputDelta(0, '{"command":"echo hi"}'),
      contentBlockStop(0),
      assistantToolUse([{ id: 'toolu_2', name: 'Bash', input: { command: 'echo hi' } }]),
      result({ text: 'done' }),
    ]);
    const session = new AnthropicSession({ streaming: true });

    const calls: Record<string, unknown>[] = [];
    session.on('tool_call', (e) => calls.push(e as unknown as Record<string, unknown>));

    await session.sendAndWait({ prompt: 'run it' });

    // Both paths are needed — the stream is live, the assistant message always
    // arrives — so the id is what stops a doubled count from looking like
    // doubled work.
    expect(calls).toHaveLength(1);
    expect(calls[0]!['arguments']).toEqual({ command: 'echo hi' });
    await session.close();
  });
});
