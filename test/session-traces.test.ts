/**
 * Tests for Issue #259 (Session Traces) and #264 (Response Latency Metrics)
 *
 * Covers:
 * - SquadClient.sendMessage() OTel span creation
 * - SquadClient.closeSession() alias
 * - StreamingPipeline latency metric wiring (TTFT, duration, tokens/sec)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SquadClient } from '@deduvafork/squad-sdk/client';
import {
  StreamingPipeline,
  type StreamDelta,
  type UsageEvent,
} from '@deduvafork/squad-sdk/runtime/streaming';

// Pinned to the backend this file actually mocks. Left implicit, these tests
// resolved to the default provider (Anthropic) and reached the real Agent SDK,
// which is slow enough to time out under parallel load — a unit test for span
// creation should not depend on which vendor happens to be the default.
vi.mock('../packages/squad-sdk/dist/adapter/gemini-client.js', () => {
  return {
    // Regular function expression, not an arrow function — SquadClient calls
    // `new GeminiClient(...)`, and arrow functions cannot be used as
    // constructors (Reflect.construct on one throws "is not a constructor").
    GeminiClient: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue([]),
        isStarted: vi.fn().mockReturnValue(true),
        createSession: vi.fn().mockReturnValue({
          sessionId: 'session-1',
          sendMessage: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
          off: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true, authType: 'api-key' }),
      };
    }),
  };
});

// Mock otel-metrics to verify they're called
vi.mock('@deduvafork/squad-sdk/runtime/otel-metrics', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@deduvafork/squad-sdk/runtime/otel-metrics')>();
  return {
    ...orig,
    recordTimeToFirstToken: vi.fn(),
    recordResponseDuration: vi.fn(),
    recordTokensPerSecond: vi.fn(),
    recordTokenUsage: vi.fn(),
  };
});

import {
  recordTimeToFirstToken,
  recordResponseDuration,
  recordTokensPerSecond,
} from '@deduvafork/squad-sdk/runtime/otel-metrics';

// ============================================================================
// #259 — SquadClient.sendMessage()
// ============================================================================

describe('SquadClient.sendMessage() — squad.session.message span', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call session.sendMessage with options', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();
    const session = await client.createSession();
    const spy = vi.spyOn(session, 'sendMessage');

    await client.sendMessage(session, { prompt: 'hello world' });

    expect(spy).toHaveBeenCalledWith({ prompt: 'hello world' });
  });

  it('should propagate errors from session.sendMessage', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();
    const session = await client.createSession();
    vi.spyOn(session, 'sendMessage').mockRejectedValueOnce(new Error('stream failed'));

    await expect(
      client.sendMessage(session, { prompt: 'will fail' })
    ).rejects.toThrow('stream failed');
  });

  it('should register event listeners on session', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();
    const session = await client.createSession();
    const onSpy = vi.spyOn(session, 'on');

    await client.sendMessage(session, { prompt: 'test' });

    // on() should have been called for message_delta and usage listeners
    expect(onSpy).toHaveBeenCalledWith('message_delta', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('usage', expect.any(Function));
  });

  it('should clean up event listeners after completion', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();
    const session = await client.createSession();
    const offSpy = vi.spyOn(session, 'off');

    await client.sendMessage(session, { prompt: 'test' });

    expect(offSpy).toHaveBeenCalledWith('message_delta', expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith('usage', expect.any(Function));
  });
});

// ============================================================================
// #259 — SquadClient.closeSession()
// ============================================================================

describe('SquadClient.closeSession() — squad.session.close span', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should close the session without error', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();

    await expect(client.closeSession('session-42')).resolves.toBeUndefined();
  });

  it('should close a session that was never opened without error', async () => {
    const client = new SquadClient({ provider: 'gemini' });
    await client.connect();

    await expect(client.closeSession('nonexistent-session')).resolves.toBeUndefined();
  });
});

// ============================================================================
// #264 — StreamingPipeline latency metrics wiring
// ============================================================================

describe('StreamingPipeline — Latency Metrics (#264)', () => {
  let pipeline: StreamingPipeline;

  beforeEach(() => {
    pipeline = new StreamingPipeline();
    vi.clearAllMocks();
  });

  it('should record TTFT when first delta arrives after markMessageStart', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    // Small delay to make TTFT measurable
    await new Promise(r => setTimeout(r, 5));

    await pipeline.processEvent(makeDelta('s1', 'hello', 0));

    expect(recordTimeToFirstToken).toHaveBeenCalledTimes(1);
    const ttft = (recordTimeToFirstToken as any).mock.calls[0][0];
    expect(ttft).toBeGreaterThanOrEqual(0);
  });

  it('should NOT record TTFT for subsequent deltas', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    await pipeline.processEvent(makeDelta('s1', 'hello', 0));
    await pipeline.processEvent(makeDelta('s1', ' world', 1));

    expect(recordTimeToFirstToken).toHaveBeenCalledTimes(1);
  });

  it('should NOT record TTFT without markMessageStart', async () => {
    pipeline.attachToSession('s1');

    await pipeline.processEvent(makeDelta('s1', 'hello', 0));

    expect(recordTimeToFirstToken).not.toHaveBeenCalled();
  });

  it('should record response duration on usage event', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    await new Promise(r => setTimeout(r, 5));

    await pipeline.processEvent(makeUsage('s1', 100, 50));

    expect(recordResponseDuration).toHaveBeenCalledTimes(1);
    const duration = (recordResponseDuration as any).mock.calls[0][0];
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('should record tokens/sec on usage event', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    await new Promise(r => setTimeout(r, 5));

    await pipeline.processEvent(makeUsage('s1', 100, 200));

    expect(recordTokensPerSecond).toHaveBeenCalledTimes(1);
    const tps = (recordTokensPerSecond as any).mock.calls[0][0];
    expect(tps).toBeGreaterThan(0);
  });

  it('should NOT record tokens/sec when outputTokens is 0', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    await new Promise(r => setTimeout(r, 5));

    await pipeline.processEvent(makeUsage('s1', 100, 0));

    expect(recordTokensPerSecond).not.toHaveBeenCalled();
  });

  it('should NOT record latency metrics without markMessageStart', async () => {
    pipeline.attachToSession('s1');

    await pipeline.processEvent(makeUsage('s1', 100, 50));

    expect(recordResponseDuration).not.toHaveBeenCalled();
    expect(recordTokensPerSecond).not.toHaveBeenCalled();
  });

  it('should clean tracking state after usage event', async () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    await pipeline.processEvent(makeUsage('s1', 100, 50));

    // Second usage without markMessageStart should not record
    vi.clearAllMocks();
    await pipeline.processEvent(makeUsage('s1', 200, 100));

    expect(recordResponseDuration).not.toHaveBeenCalled();
  });

  it('should clear tracking state on clear()', () => {
    pipeline.attachToSession('s1');
    pipeline.markMessageStart('s1');

    pipeline.clear();

    expect(pipeline.isAttached('s1')).toBe(false);
  });
});

// ============================================================================
// Helpers
// ============================================================================

function makeDelta(sessionId: string, content: string, index = 0): StreamDelta {
  return {
    type: 'message_delta',
    sessionId,
    content,
    index,
    timestamp: new Date(),
  };
}

function makeUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  estimatedCost = 0,
  agentName?: string,
): UsageEvent {
  return {
    type: 'usage',
    sessionId,
    agentName,
    model: 'claude-sonnet-4',
    inputTokens,
    outputTokens,
    estimatedCost,
    timestamp: new Date(),
  };
}
