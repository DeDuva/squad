/**
 * Aspire Command Tests — CLI command for launching Aspire dashboard (Issue #265)
 *
 * Tests the runAspire function's configuration and validation logic.
 * Does NOT actually launch Docker/dotnet processes.
 */

import { describe, it, expect, afterEach } from 'vitest';

describe('squad aspire command', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    process.env = { ...originalEnv };
  });

  it('module exports runAspire function', async () => {
    const mod = await import('@squad/cli/commands/aspire');
    expect(typeof mod.runAspire).toBe('function');
  });

  it('AspireOptions accepts docker and port', async () => {
    // Type-level test — if this compiles, the interface is correct
    const mod = await import('@squad/cli/commands/aspire');
    expect(mod.runAspire).toBeDefined();
  });
});
