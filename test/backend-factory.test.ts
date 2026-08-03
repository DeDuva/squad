/**
 * Backend selection precedence.
 *
 * The ordering here is the whole contract: which signal wins decides what a
 * given developer's session actually runs on, and one of the rules exists
 * purely to keep every pre-existing caller working.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveProvider } from '../packages/squad-sdk/src/adapter/backend-factory.js';

function squadDirWith(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'squad-provider-'));
  const dir = join(root, '.squad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

const created: string[] = [];
function tempSquadDir(config: Record<string, unknown>): string {
  const dir = squadDirWith(config);
  created.push(dir);
  return dir;
}

/**
 * Env is passed explicitly rather than set on `process.env`. vitest shares a
 * process across concurrently-running test files, so mutating the real
 * environment here leaks into whatever else happens to be running.
 */
const NO_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  while (created.length) rmSync(join(created.pop()!, '..'), { recursive: true, force: true });
});

describe('resolveProvider', () => {
  it('defaults to anthropic when nothing else says otherwise', () => {
    expect(resolveProvider({ env: NO_ENV })).toBe('anthropic');
  });

  it('honours an explicit provider above everything else', () => {
    const squadDir = tempSquadDir({ provider: 'anthropic' });

    expect(
      resolveProvider({ provider: 'gemini', squadDir, env: { SQUAD_PROVIDER: 'anthropic' } }),
    ).toBe('gemini');
  });

  it('reads the persisted preference from .squad/config.json', () => {
    expect(resolveProvider({ squadDir: tempSquadDir({ provider: 'gemini' }), env: NO_ENV })).toBe('gemini');
  });

  it('prefers the persisted preference over the environment', () => {
    const squadDir = tempSquadDir({ provider: 'gemini' });

    expect(resolveProvider({ squadDir, env: { SQUAD_PROVIDER: 'anthropic' } })).toBe('gemini');
  });

  it('falls back to SQUAD_PROVIDER when nothing is persisted', () => {
    expect(resolveProvider({ env: { SQUAD_PROVIDER: 'gemini' } })).toBe('gemini');
  });

  it('ignores an unrecognized persisted provider rather than failing', () => {
    // Most likely a config written by a newer squad. Falling through beats
    // refusing to start a session over a field we don't understand.
    const squadDir = tempSquadDir({ provider: 'some-future-backend' });

    expect(resolveProvider({ squadDir, env: NO_ENV })).toBe('anthropic');
  });

  it('ignores an unrecognized SQUAD_PROVIDER', () => {
    expect(resolveProvider({ env: { SQUAD_PROVIDER: 'not-a-backend' } })).toBe('anthropic');
  });

  it('tolerates a malformed config.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'squad-provider-bad-'));
    const dir = join(root, '.squad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ not json');
    try {
      expect(resolveProvider({ squadDir: dir, env: NO_ENV })).toBe('anthropic');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveProvider — back-compat for existing callers', () => {
  it('treats an explicitly passed geminiApiKey as choosing Gemini', () => {
    // This is what keeps every pre-existing `new SquadClient({ geminiApiKey })`
    // — and the tests built on them — on their current backend with no edits.
    expect(resolveProvider({ geminiApiKey: 'test-key', env: NO_ENV })).toBe('gemini');
  });

  it('does NOT let a GEMINI_API_KEY env var pin the provider', () => {
    // Merely having a key exported is not a decision. If it counted, anyone
    // with one in their shell would be stuck on Gemini and the default could
    // never move.
    expect(resolveProvider({ env: { GEMINI_API_KEY: 'ambient-key' } })).toBe('anthropic');
  });

  it('lets an explicit provider override a passed geminiApiKey', () => {
    expect(resolveProvider({ provider: 'anthropic', geminiApiKey: 'test-key', env: NO_ENV })).toBe('anthropic');
  });
});
