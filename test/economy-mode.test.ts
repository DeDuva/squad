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
  it('maps premium Gemini models to standard', () => {
    expect(ECONOMY_MODEL_MAP['gemini-2.5-pro-preview-05-06']).toBe('gemini-2.5-flash-preview-04-17');
    expect(ECONOMY_MODEL_MAP['gemini-2.5-pro']).toBe('gemini-2.5-flash');
  });

  it('maps standard flash models to fast', () => {
    expect(ECONOMY_MODEL_MAP['gemini-2.5-flash-preview-04-17']).toBe('gemini-2.0-flash');
    expect(ECONOMY_MODEL_MAP['gemini-2.5-flash']).toBe('gemini-2.0-flash');
  });

  it('maps fast flash to lite', () => {
    expect(ECONOMY_MODEL_MAP['gemini-2.0-flash']).toBe('gemini-2.0-flash-lite');
  });
});

describe('applyEconomyMode', () => {
  it('returns economy model for known Gemini models', () => {
    expect(applyEconomyMode('gemini-2.5-pro-preview-05-06')).toBe('gemini-2.5-flash-preview-04-17');
    expect(applyEconomyMode('gemini-2.5-flash-preview-04-17')).toBe('gemini-2.0-flash');
    expect(applyEconomyMode('gemini-2.0-flash')).toBe('gemini-2.0-flash-lite');
  });

  it('returns original model when no economy mapping exists', () => {
    expect(applyEconomyMode('gemini-2.0-flash-lite')).toBe('gemini-2.0-flash-lite');
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
      JSON.stringify({ version: 1, defaultModel: 'gemini-2.5-pro-preview-05-06' })
    );
    writeEconomyMode(squadDir, true);
    const raw = JSON.parse(readFileSync(join(squadDir, 'config.json'), 'utf-8'));
    expect(raw.defaultModel).toBe('gemini-2.5-pro-preview-05-06');
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
  it('Layer 4 default: uses gemini-2.0-flash instead of standard when economyMode: true', () => {
    expect(resolveModel({ economyMode: true })).toBe('gemini-2.0-flash');
  });

  it('Layer 4 default: uses gemini-2.5-flash-preview-04-17 when economyMode: false', () => {
    expect(resolveModel({ economyMode: false })).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('Layer 3 standard task: downgrades to fast when economyMode: true', () => {
    expect(resolveModel({ taskModel: 'gemini-2.5-flash-preview-04-17', economyMode: true })).toBe('gemini-2.0-flash');
  });

  it('Layer 3 premium task: downgrades to standard when economyMode: true', () => {
    expect(resolveModel({ taskModel: 'gemini-2.5-pro-preview-05-06', economyMode: true })).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('Layer 3 fast task: downgrades to lite when economyMode: true', () => {
    expect(resolveModel({ taskModel: 'gemini-2.0-flash', economyMode: true })).toBe('gemini-2.0-flash-lite');
  });

  it('Layer 2 charter preference: NOT overridden by economy mode', () => {
    expect(
      resolveModel({ charterPreference: 'gemini-2.5-pro-preview-05-06', economyMode: true })
    ).toBe('gemini-2.5-pro-preview-05-06');
  });

  it('Layer 1 session directive: NOT overridden by economy mode', () => {
    expect(
      resolveModel({ sessionDirective: 'gemini-2.5-pro-preview-05-06', economyMode: true })
    ).toBe('gemini-2.5-pro-preview-05-06');
  });

  it('Layer 0b global config: NOT overridden by economy mode', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, defaultModel: 'gemini-2.5-pro-preview-05-06' })
    );
    expect(
      resolveModel({ squadDir, taskModel: 'gemini-2.5-flash-preview-04-17', economyMode: true })
    ).toBe('gemini-2.5-pro-preview-05-06');
  });

  it('Layer 0a per-agent override: NOT overridden by economy mode', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({
        version: 1,
        agentModelOverrides: { eecom: 'gemini-2.5-pro-preview-05-06' },
      })
    );
    expect(
      resolveModel({ agentName: 'eecom', squadDir, taskModel: 'gemini-2.0-flash', economyMode: true })
    ).toBe('gemini-2.5-pro-preview-05-06');
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
    expect(resolveModel({ squadDir, taskModel: 'gemini-2.5-flash-preview-04-17' })).toBe('gemini-2.0-flash');
  });

  it('uses normal model when economyMode absent from config', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1 })
    );
    expect(resolveModel({ squadDir, taskModel: 'gemini-2.5-flash-preview-04-17' })).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('explicit economyMode option overrides config setting', () => {
    writeFileSync(
      join(squadDir, 'config.json'),
      JSON.stringify({ version: 1, economyMode: false })
    );
    // Option says true, config says false → option wins
    expect(
      resolveModel({ squadDir, taskModel: 'gemini-2.5-flash-preview-04-17', economyMode: true })
    ).toBe('gemini-2.0-flash');
  });
});

// ============================================================================
// SDK model-selector resolveModel economy mode
// ============================================================================

describe('SDK resolveModel (agents) economy mode', () => {
  it('code task → gemini-2.0-flash when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'code', economyMode: true });
    expect(result.model).toBe('gemini-2.0-flash');
    expect(result.source).toBe('task-auto');
  });

  it('docs task → gemini-2.0-flash-lite when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'docs', economyMode: true });
    expect(result.model).toBe('gemini-2.0-flash-lite');
  });

  it('mechanical task → gemini-2.0-flash-lite when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'mechanical', economyMode: true });
    expect(result.model).toBe('gemini-2.0-flash-lite');
  });

  it('visual task → gemini-2.5-flash-preview-04-17 when economyMode: true', () => {
    const result = sdkResolveModel({ taskType: 'visual', economyMode: true });
    expect(result.model).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('code task → gemini-2.5-flash-preview-04-17 when economyMode: false', () => {
    const result = sdkResolveModel({ taskType: 'code', economyMode: false });
    expect(result.model).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('user override NOT affected by economy mode', () => {
    const result = sdkResolveModel({
      taskType: 'code',
      userOverride: 'gemini-2.5-pro-preview-05-06',
      economyMode: true,
    });
    expect(result.model).toBe('gemini-2.5-pro-preview-05-06');
    expect(result.source).toBe('user-override');
  });

  it('charter preference NOT affected by economy mode', () => {
    const result = sdkResolveModel({
      taskType: 'code',
      charterPreference: 'gemini-2.5-pro-preview-05-06',
      economyMode: true,
    });
    expect(result.model).toBe('gemini-2.5-pro-preview-05-06');
    expect(result.source).toBe('charter');
  });
});
