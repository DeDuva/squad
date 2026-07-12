/**
 * Unit tests for SquadClient (AI SDK backend).
 *
 * Mocks AiSdkClient so tests don't require a real API key.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SquadClient } from '@deduvafork/squad-sdk/client';

vi.mock('../packages/squad-sdk/dist/adapter/ai-sdk-client.js', () => {
  return {
    // Regular function expression, not an arrow function — SquadClient calls
    // `new AiSdkClient(...)`, and arrow functions cannot be used as
    // constructors (Reflect.construct on one throws "is not a constructor").
    AiSdkClient: vi.fn().mockImplementation(function () {
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

describe('SquadClient — Connection Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs with minimal options', () => {
    const client = new SquadClient();
    expect(client).toBeDefined();
    expect(client.getState()).toBe('disconnected');
    expect(client.isConnected()).toBe(false);
  });

  it('connects and transitions state to connected', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    expect(client.getState()).toBe('connected');
    expect(client.isConnected()).toBe(true);
  });

  it('deduplicates concurrent connect() calls', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    const [p1, p2] = [client.connect(), client.connect()];
    await Promise.all([p1, p2]);
    expect(client.isConnected()).toBe(true);
  });

  it('returns connected immediately on second connect()', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    await client.connect(); // should be a no-op
    expect(client.isConnected()).toBe(true);
  });

  it('transitions to disconnected after disconnect()', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    await client.disconnect();
    expect(client.getState()).toBe('disconnected');
  });
});

describe('SquadClient — Session Management', () => {
  it('creates a session when connected', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    const session = await client.createSession({ model: 'gemini-pro-latest' });
    expect(session).toBeDefined();
    expect(session.sessionId).toBe('session-1');
  });

  it('auto-connects when autoStart is true and not connected', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key', autoStart: true });
    const session = await client.createSession();
    expect(session).toBeDefined();
    expect(client.isConnected()).toBe(true);
  });

  it('throws when not connected and autoStart is false', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key', autoStart: false });
    await expect(client.createSession()).rejects.toThrow('not connected');
  });

  it('listSessions returns empty array (Gemini is stateless)', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    const sessions = await client.listSessions();
    expect(sessions).toEqual([]);
  });

  it('getLastSessionId returns undefined (Gemini is stateless)', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    const id = await client.getLastSessionId();
    expect(id).toBeUndefined();
  });
});

describe('SquadClient — Auth and Status', () => {
  it('getAuthStatus delegates to the backend client', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    await client.connect();
    const status = await client.getAuthStatus();
    expect(status.isAuthenticated).toBe(true);
    expect(status.authType).toBe('api-key');
  });

  it('getStatus returns Gemini sentinel values', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    const status = await client.getStatus();
    expect(status.version).toBe('gemini');
  });

  it('ping returns pong', async () => {
    const client = new SquadClient({ geminiApiKey: 'test-key' });
    const result = await client.ping();
    expect(result.message).toBe('pong');
    expect(typeof result.timestamp).toBe('number');
  });
});
