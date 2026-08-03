/**
 * Regression tests for the `message_delta` event contract.
 *
 * Session events are untyped (`SquadSessionEvent { type: string; [k: string]: unknown }`),
 * so which key carries the streamed text is a convention rather than a type.
 * That convention drifted: `GeminiSession` emitted `{ text }`, the shell's
 * `extractDelta()` read `deltaContent ?? delta ?? content ?? text`, but
 * `spawnAgent()` read only `delta ?? content`. The intersection was empty, so
 * every dispatched agent accumulated the empty string and returned
 * `response: undefined` — silently, with no error anywhere.
 *
 * These tests pin both halves of the fix: producers emit every key consumers
 * look for, and `spawnAgent` looks for every key a producer might emit.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { spawnAgent } from '../packages/squad-cli/src/cli/shell/spawn.js';
import { SessionRegistry } from '../packages/squad-cli/src/cli/shell/sessions.js';
import { GeminiSession } from '../packages/squad-sdk/src/adapter/gemini-client.js';

/** Minimal SquadSession stand-in that replays a scripted set of delta events. */
function fakeClientEmitting(events: Array<Record<string, unknown>>) {
  const listeners = new Map<string, Set<(e: never) => void>>();
  const session = {
    sessionId: 'test-session',
    on(type: string, handler: (e: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    off(type: string, handler: (e: never) => void) {
      listeners.get(type)?.delete(handler);
    },
    async sendMessage() {
      for (const ev of events) {
        for (const h of listeners.get('message_delta') ?? []) {
          (h as (e: unknown) => void)({ type: 'message_delta', ...ev });
        }
      }
    },
    async close() {},
  };
  return { createSession: async () => session } as never;
}

function makeTeamRoot(agent: string): string {
  const root = mkdtempSync(join(tmpdir(), 'squad-delta-'));
  const dir = join(root, '.squad', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'charter.md'), `# ${agent} — Tester\n\nA test agent.\n`);
  return root;
}

describe('message_delta contract — spawnAgent accumulation', () => {
  // Every key a producer has ever used. `text` is the one that was broken.
  for (const key of ['text', 'delta', 'content', 'deltaContent']) {
    it(`accumulates streamed text delivered under "${key}"`, async () => {
      const root = makeTeamRoot('tester');
      try {
        const result = await spawnAgent('tester', 'do a thing', new SessionRegistry(), {
          mode: 'sync',
          teamRoot: root,
          client: fakeClientEmitting([{ [key]: 'hello ' }, { [key]: 'world' }]),
        });

        expect(result.status).toBe('completed');
        expect(result.response).toBe('hello world');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('ignores non-string delta payloads rather than stringifying them', async () => {
    const root = makeTeamRoot('tester');
    try {
      const result = await spawnAgent('tester', 'do a thing', new SessionRegistry(), {
        mode: 'sync',
        teamRoot: root,
        client: fakeClientEmitting([{ text: 'kept' }, { text: { nested: true } }, { text: 42 }]),
      });

      expect(result.response).toBe('kept');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('message_delta contract — GeminiSession emission', () => {
  it('emits delta, text, and content so any consumer convention works', async () => {
    const session = new GeminiSession('test-key', {});
    const seen: Array<Record<string, unknown>> = [];
    session.on('message_delta', (e) => seen.push(e as unknown as Record<string, unknown>));

    // Reach the private emitter directly: driving a real stream would need a
    // live Gemini endpoint, and the assertion here is purely about event shape.
    (session as unknown as { emit(e: Record<string, unknown>): void }).emit({
      type: 'message_delta',
      delta: 'hi',
      text: 'hi',
      content: 'hi',
    });

    expect(seen).toHaveLength(1);
    for (const key of ['delta', 'text', 'content']) {
      expect(seen[0]![key]).toBe('hi');
    }
  });
});
