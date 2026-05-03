import { describe, it, expect, vi } from 'vitest';
import { SquadClientWithPool } from '@deduvafork/squad-sdk/client';
import { SessionPool, DEFAULT_POOL_CONFIG } from '@deduvafork/squad-sdk/client';
import { EventBus } from '@deduvafork/squad-sdk/client';

vi.mock('../packages/squad-sdk/dist/adapter/gemini-client.js', () => {
  return {
    GeminiClient: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue([]),
      isStarted: vi.fn().mockReturnValue(false),
      createSession: vi.fn().mockReturnValue({
        sessionId: 'test-session',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true, authType: 'api-key' }),
    })),
  };
});

describe('SquadClientWithPool', () => {
  it('should construct with pool config', () => {
    const client = new SquadClientWithPool({
      pool: { maxConcurrent: 5 }
    });
    expect(client).toBeDefined();
    expect(client.pool).toBeDefined();
    expect(client.eventBus).toBeDefined();
  });

  it('should have pool with correct capacity', () => {
    const client = new SquadClientWithPool({
      pool: { maxConcurrent: 3 }
    });
    expect(client.pool.size).toBe(0);
    expect(client.pool.atCapacity).toBe(false);
  });

  it('should check connection state', () => {
    const client = new SquadClientWithPool();
    expect(client.isConnected()).toBe(false);
    expect(client.getState()).toBe('disconnected');
  });
});

describe('SessionPool', () => {
  it('should construct with default config', () => {
    const pool = new SessionPool();
    expect(pool.size).toBe(0);
    expect(pool.atCapacity).toBe(false);
  });

  it('should report default config values', () => {
    expect(DEFAULT_POOL_CONFIG.maxConcurrent).toBe(10);
    expect(DEFAULT_POOL_CONFIG.idleTimeout).toBe(300_000);
  });
});

describe('EventBus', () => {
  it('should subscribe and emit events', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.on('session.created', (event) => {
      received.push(event.type);
    });

    await bus.emit({
      type: 'session.created',
      payload: { test: true },
      timestamp: new Date(),
    });

    expect(received).toEqual(['session.created']);
  });

  it('should support wildcard subscriptions via onAny', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.onAny((event) => {
      received.push(event.type);
    });

    await bus.emit({ type: 'session.created', payload: null, timestamp: new Date() });
    await bus.emit({ type: 'session.destroyed', payload: null, timestamp: new Date() });

    expect(received).toEqual(['session.created', 'session.destroyed']);
  });

  it('should return unsubscribe function', async () => {
    const bus = new EventBus();
    let count = 0;

    const unsub = bus.on('session.error', () => { count++; });

    await bus.emit({ type: 'session.error', payload: null, timestamp: new Date() });
    expect(count).toBe(1);

    unsub();
    await bus.emit({ type: 'session.error', payload: null, timestamp: new Date() });
    expect(count).toBe(1); // unchanged after unsub
  });
});
