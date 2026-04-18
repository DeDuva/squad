/**
 * Tests for Response Tier Selection (M3-4, Issue #143)
 */

import { describe, it, expect } from 'vitest';
import {
  selectResponseTier,
  getTier,
  type ResponseTier,
  type TierName,
  type TierContext,
} from '@squad/sdk/coordinator';
import { DEFAULT_CONFIG, defineConfig, type SquadConfig } from '@squad/sdk/config';

// --- getTier ---

describe('getTier', () => {
  it('should return direct tier', () => {
    const tier = getTier('direct');
    expect(tier.tier).toBe('direct');
    expect(tier.modelTier).toBe('none');
    expect(tier.maxAgents).toBe(0);
  });

  it('should return lightweight tier', () => {
    const tier = getTier('lightweight');
    expect(tier.tier).toBe('lightweight');
    expect(tier.modelTier).toBe('fast');
    expect(tier.maxAgents).toBe(1);
  });

  it('should return standard tier', () => {
    const tier = getTier('standard');
    expect(tier.tier).toBe('standard');
    expect(tier.modelTier).toBe('standard');
    expect(tier.maxAgents).toBe(1);
  });

  it('should return full tier', () => {
    const tier = getTier('full');
    expect(tier.tier).toBe('full');
    expect(tier.modelTier).toBe('premium');
    expect(tier.maxAgents).toBe(5);
  });

  it('should return a copy (not shared reference)', () => {
    const a = getTier('standard');
    const b = getTier('standard');
    a.timeout = 999;
    expect(b.timeout).not.toBe(999);
  });
});

// --- selectResponseTier ---

describe('selectResponseTier', () => {
  const config = DEFAULT_CONFIG;

  describe('direct tier (simple messages)', () => {
    it('should select direct for greetings', () => {
      expect(selectResponseTier('hello', config).tier).toBe('direct');
    });

    it('should select direct for "thanks"', () => {
      expect(selectResponseTier('thanks', config).tier).toBe('direct');
    });

    it('should select direct for "what is your name"', () => {
      expect(selectResponseTier("what's your name", config).tier).toBe('direct');
    });

    it('should select direct for "help"', () => {
      expect(selectResponseTier('help', config).tier).toBe('direct');
    });
  });

  describe('full tier (complex tasks)', () => {
    it('should select full for "refactor the entire codebase"', () => {
      expect(
        selectResponseTier('refactor the entire codebase', config).tier,
      ).toBe('full');
    });

    it('should select full for "implement a new feature module"', () => {
      expect(
        selectResponseTier('implement a new feature module', config).tier,
      ).toBe('full');
    });

    it('should select full for "security audit"', () => {
      expect(
        selectResponseTier('run a security audit on the system', config).tier,
      ).toBe('full');
    });

    it('should select full for "full review"', () => {
      expect(
        selectResponseTier('do a full review of the API', config).tier,
      ).toBe('full');
    });

    it('should select full for multi-agent tasks', () => {
      expect(
        selectResponseTier('multi-agent coordination needed', config).tier,
      ).toBe('full');
    });
  });

  describe('lightweight tier', () => {
    it('should select lightweight for "list the open issues"', () => {
      expect(
        selectResponseTier('list the open issues in the repo', config).tier,
      ).toBe('lightweight');
    });

    it('should select lightweight for "show status"', () => {
      expect(
        selectResponseTier('show me the current status of all agents', config).tier,
      ).toBe('lightweight');
    });
  });

  describe('standard tier (default)', () => {
    it('should default to standard for ambiguous messages', () => {
      expect(
        selectResponseTier('fix the authentication bug in login.ts and add error handling', config).tier,
      ).toBe('standard');
    });
  });

  describe('config tier overrides', () => {
    it('should use routing rule tier when pattern matches', () => {
      const custom = defineConfig({
        routing: {
          rules: [
            { pattern: 'quick-fix', agents: ['dev'], tier: 'lightweight' },
          ],
        },
      });
      expect(
        selectResponseTier('apply the quick-fix for the header', custom).tier,
      ).toBe('lightweight');
    });
  });

  describe('load adjustment', () => {
    it('should downgrade full → standard when load ≥ 4', () => {
      const ctx: TierContext = { currentLoad: 4 };
      const tier = selectResponseTier(
        'refactor the entire system',
        config,
        ctx,
      );
      expect(tier.tier).toBe('standard');
    });

    it('should downgrade standard → lightweight when load ≥ 6', () => {
      const ctx: TierContext = { currentLoad: 6 };
      const tier = selectResponseTier(
        'fix the authentication bug in login.ts and add error handling',
        config,
        ctx,
      );
      expect(tier.tier).toBe('lightweight');
    });

    it('should not downgrade direct tier regardless of load', () => {
      const ctx: TierContext = { currentLoad: 10 };
      expect(selectResponseTier('hello', config, ctx).tier).toBe('direct');
    });
  });

  describe('history context', () => {
    it('should suggest standard when recent history is long', () => {
      const ctx: TierContext = {
        recentHistory: ['msg1', 'msg2', 'msg3', 'msg4'],
      };
      const tier = selectResponseTier(
        'continue working on the task',
        config,
        ctx,
      );
      expect(tier.tier).toBe('standard');
    });
  });
});
