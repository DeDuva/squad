/**
 * Tests for economy mode model selection (issue #500).
 *
 * Validates that when economy mode is active:
 *   - Layer 3 (task-aware) and Layer 4 (default) models are downgraded
 *   - Layer 0–2 (explicit preferences) are never overridden
 *   - config.json read/write round-trips correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveModel,
  readEconomyMode,
  writeEconomyMode,
  applyEconomyMode,
  ECONOMY_MODEL_MAP,
} from '@deduvafork/squad-sdk/config';
import {
  resolveModel as sdkResolveModel,
} from '@deduvafork/squad-sdk/agents';

let squadDir: string;

beforeEach(() => {
  squadDir = mkdtempSync(join(tmpdir(), 'squad-economy-'));
});

afterEach(() => {
  rmSync(squadDir, { recursive: true, force: true });
});

// ============================================================================
// ECONOMY_MODEL_MAP + applyEconomyMode
// ============================================================================

describe('ECONOMY_MODEL_MAP', () => {
  it('maps premium model to flash', () => {
    expect(ECONOMY_MODEL_MAP['gemini-pro-latest']).toBe('gemini-flash-latest');
  });

  it('has no entry for flash (already at base)', () => {
    expect(ECONOMY_MODEL_MAP['gemini-flash-latest']).toBeUndefined();
  });
});

describe('applyEconomyMode', () => {
  it('downgrades pro to flash', () => {
    expect(applyEconomyMode('gemini-pro-latest')).toBe('gemini-flash-latest');
  });

  it('returns original model when no economy mapping exists', () => {
    expect(applyEconomyMode('gemini-flash-latest')).toBe('gemini-flash-latest');
    expect(applyEconomyMode('unknown-model-xyz')).toBe('unknown-model-xyz');
  });
});

// ============================================================================
// readEconomyMode / writeEconomyMode
// ============================================================================

describe('readEconomyMode', () => {
  it('returns false when config.json does not exist', () => {
    expect(readEconomyMode(squadDir)).toBe(false);
  });

  it('returns false when economyMode field is absent', () => {
    writeFileSync(join(squadDir, 'config.json'), JSON.stringify({ version: 1 }));
    expect(readEconomyMode(squadDir)).toBe(false);
  });

  it('returns false when economyMode is false', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: false })
    );
    expect(readEconomyMode(squadDir)).toBe(false);
  });

  it('returns true when economyMode is true', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: true })
    );
    expect(readEconomyMode(squadDir)).toBe(true);
  });

  it('returns false on malformed JSON', () => {
    writeFileSync(join(squadDir, 'config.json'), '{ bad json');
    expect(readEconomyMode(squadDir)).toBe(false);
  });
});

describe('writeEconomyMode', () => {
  it('creates config.json with economyMode: true', () => {
    writeEconomyMode(squadDir, true);
    const raw = JSON.parse(readFileSync(join(squadDir, 'config.json'), 'utf-8'));
    expect(raw.economyMode).toBe(true);
    expect(raw.version).toBe(1);
  });

  it('removes economyMode field when set to false', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: true })
    );
    writeEconomyMode(squadDir, false);
    const raw = JSON.parse(readFileSync(join(squadDir, 'config.json'), 'utf-8'));
    expect(raw).not.toHaveProperty('economyMode');
  });

  it('merges with existing config without clobbering other fields', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, defaultModel: 'gemini-pro-latest' })
    );
    writeEconomyMode(squadDir, true);
    const raw = JSON.parse(readFileSync(join(squadDir, 'config.json'), 'utf-8'));
    expect(raw.defaultModel).toBe('gemini-pro-latest');
    expect(raw.economyMode).toBe(true);
  });

  it('round-trips: write on → read true', () => {
    writeEconomyMode(squadDir, true);
    expect(readEconomyMode(squadDir)).toBe(true);
  });

  it('round-trips: write off → read false', () => {
    writeEconomyMode(squadDir, true);
    writeEconomyMode(squadDir, false);
    expect(readEconomyMode(squadDir)).toBe(false);
  });
});

// ============================================================================
// resolveModel — economy mode option
// ============================================================================

describe('resolveModel economy mode (option)', () => {
  it('Layer 4 default: uses gemini-flash-latest regardless of economy mode', () => {
    expect(resolveModel({ economyMode: true })).toBe('gemini-flash-latest');
  });

  it('Layer 4 default: uses gemini-flash-latest when economyMode: false', () => {
    expect(resolveModel({ economyMode: false })).toBe('gemini-flash-latest');
  });

  it('Layer 3 flash task: stays gemini-flash-latest when economyMode: true (no cheaper option)', () => {
    expect(resolveModel({ taskModel: 'gemini-flash-latest', economyMode: true })).toBe('gemini-flash-latest');
  });

  it('Layer 3 premium task: downgrades to flash when economyMode: true', () => {
    expect(resolveModel({ taskModel: 'gemini-pro-latest', economyMode: true })).toBe('gemini-flash-latest');
  });

  it('Layer 2 charter preference: NOT overridden by economy mode', () => {
    expect(
      resolveModel({ charterPreference: 'gemini-pro-latest', economyMode: true })
    ).toBe('gemini-pro-latest');
  });

  it('Layer 1 session directive: NOT overridden by economy mode', () => {
    expect(
      resolveModel({ sessionDirective: 'gemini-pro-latest', economyMode: true })
    ).toBe('gemini-pro-latest');
  });

  it('Layer 0b global config: NOT overridden by economy mode', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, defaultModel: 'gemini-pro-latest' })
    );
    expect(
      resolveModel({ squadDir, taskModel: 'gemini-flash-latest', economyMode: true })
    ).toBe('gemini-pro-latest');
  });

  it('Layer 0a per-agent override: NOT overridden by economy mode', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({
        version: 1,
        agentModelOverrides: { eecom: 'gemini-pro-latest' },
      })
    );
    expect(
      resolveModel({ agentName: 'eecom', squadDir, taskModel: 'gemini-flash-latest', economyMode: true })
    ).toBe('gemini-pro-latest');
  });
});

// ============================================================================
// resolveModel — economy mode from config.json
// ============================================================================

describe('resolveModel economy mode (from config)', () => {
  it('uses economy model when economyMode: true in config', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: true })
    );
    expect(resolveModel({ squadDir, taskModel: 'gemini-pro-latest' })).toBe('gemini-flash-latest');
  });

  it('uses normal model when economyMode absent from config', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1 })
    );
    expect(resolveModel({ squadDir, taskModel: 'gemini-pro-latest' })).toBe('gemini-pro-latest');
  });

  it('explicit economyMode option overrides config setting', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: false })
    );
    // Option says true, config says false → option wins
    expect(
      resolveModel({ squadDir, taskModel: 'gemini-pro-latest', economyMode: true })
    ).toBe('gemini-flash-latest');
  });
});

// ============================================================================
// SDK model-selector resolveModel economy mode
// ============================================================================

describe('SDK resolveModel (agents) economy mode', () => {
  it('code task → gemini-flash-latest when economyMode: true (no cheaper option)', () => {
    const result = sdkResolveModel({ taskType: 'code', economyMode: true });
    expect(result.model).toBe('gemini-flash-latest');
    expect(result.source).toBe('task-auto');
  });

  it('docs task → gemini-flash-latest when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'docs', economyMode: true });
    expect(result.model).toBe('gemini-flash-latest');
  });

  it('mechanical task → gemini-flash-latest when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'mechanical', economyMode: true });
    expect(result.model).toBe('gemini-flash-latest');
  });

  it('visual task → gemini-flash-latest when economyMode: true (pro → flash)', () => {
    const result = sdkResolveModel({ taskType: 'visual', economyMode: true });
    expect(result.model).toBe('gemini-flash-latest');
  });

  it('code task → gemini-flash-latest when economyMode: false', () => {
    const result = sdkResolveModel({ taskType: 'code', economyMode: false });
    expect(result.model).toBe('gemini-flash-latest');
  });

  it('user override NOT affected by economy mode', () => {
    const result = sdkResolveModel({
      taskType: 'code',
      userOverride: 'gemini-pro-latest',
      economyMode: true,
    });
    expect(result.model).toBe('gemini-pro-latest');
    expect(result.source).toBe('user-override');
  });

  it('charter preference NOT affected by economy mode', () => {
    const result = sdkResolveModel({
      taskType: 'code',
      charterPreference: 'gemini-pro-latest',
      economyMode: true,
    });
    expect(result.model).toBe('gemini-pro-latest');
    expect(result.source).toBe('charter');
  });
});
