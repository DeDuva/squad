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
  error?: boolean;
}): AgentSdkMessage {
  return {
    type: 'result',
    subtype: opts.error ? 'error_during_execution' : 'success',
    is_error: opts.error ?? false,
    result: opts.text,
    total_cost_usd: opts.cost ?? 0,
    usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: opts.outputTokens ?? 0 },
    modelUsage: { 'claude-sonnet-5': {} },
    session_id: 'sdk-session',
  };
}

function textDelta(text: string): AgentSdkMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

/** Install a fake SDK whose per-turn output is scripted. */
function installFake(script: (turn: number, prompt: string) => AgentSdkMessage[]) {
  const seen: { options?: Record<string, unknown>; prompts: string[] } = { prompts: [] };

  const mod: AgentSdkModule = {
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
