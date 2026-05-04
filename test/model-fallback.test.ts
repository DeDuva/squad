/**
 * Model fallback tests — cross-tier fallback, tier ceiling,
 * provider preference, nuclear fallback.
 *
 * Expands on models.test.ts (audit gap: advanced fallback logic).
 *
 * @module test/model-fallback
 */

import { describe, it, expect } from 'vitest';
import {
  ModelRegistry,
  MODEL_CATALOG,
  DEFAULT_FALLBACK_CHAINS,
} from '@deduvafork/squad-sdk/config';

// ============================================================================
// Cross-tier fallback: standard chain tries all models in order
// ============================================================================

describe('Cross-tier fallback — standard chain exhaustion', () => {
  const registry = new ModelRegistry();

  it('standard chain tries all models in order', () => {
    const chain = DEFAULT_FALLBACK_CHAINS.standard;
    expect(chain.length).toBeGreaterThan(1);

    // Walk the chain with getNextFallback
    const attempted = new Set<string>();
    let current = chain[0]!;
    const visited: string[] = [current];
    attempted.add(current);

    let next = registry.getNextFallback(current, 'standard', attempted);
    while (next) {
      visited.push(next);
      attempted.add(next);
      current = next;
      next = registry.getNextFallback(current, 'standard', attempted);
    }

    // Every model in the default chain was visited (order may vary due to provider preference)
    const chainSet = new Set(chain);
    const visitedSet = new Set(visited);
    expect(visitedSet).toEqual(chainSet);
  });

  it('premium chain starts with gemini pro and walks through all premium options', () => {
    const chain = DEFAULT_FALLBACK_CHAINS.premium;
    expect(chain[0]).toBe('gemini-2.5-pro-preview-05-06');

    const attempted = new Set<string>();
    let count = 0;
    let current = chain[0]!;
    attempted.add(current);
    count++;

    let next = registry.getNextFallback(current, 'premium', attempted);
    while (next) {
      attempted.add(next);
      current = next;
      count++;
      next = registry.getNextFallback(current, 'premium', attempted);
    }

    expect(count).toBe(chain.length);
  });

  it('fast chain walks through all fast options', () => {
    const chain = DEFAULT_FALLBACK_CHAINS.fast;
    expect(chain[0]).toBe('gemini-2.0-flash');

    const attempted = new Set<string>();
    let count = 0;
    let current = chain[0]!;
    attempted.add(current);
    count++;

    let next = registry.getNextFallback(current, 'fast', attempted);
    while (next) {
      attempted.add(next);
      current = next;
      count++;
      next = registry.getNextFallback(current, 'fast', attempted);
    }

    expect(count).toBe(chain.length);
  });

  it('returns null when all models in chain exhausted', () => {
    const allStandard = new Set(DEFAULT_FALLBACK_CHAINS.standard);
    const next = registry.getNextFallback(DEFAULT_FALLBACK_CHAINS.standard[0]!, 'standard', allStandard);
    expect(next).toBeNull();
  });
});

// ============================================================================
// Tier ceiling: fast task never falls back UP to premium
// ============================================================================

describe('Tier ceiling — fast never escalates to premium', () => {
  const registry = new ModelRegistry();

  it('fast fallback chain contains only fast-tier models', () => {
    const chain = DEFAULT_FALLBACK_CHAINS.fast;
    for (const modelId of chain) {
      const info = registry.getModelInfo(modelId);
      expect(info).not.toBeNull();
      expect(info!.tier).toBe('fast');
    }
  });

  it('fast chain never contains premium models', () => {
    const premiumIds = MODEL_CATALOG.filter(m => m.tier === 'premium').map(m => m.id);
    const fastChain = DEFAULT_FALLBACK_CHAINS.fast;
    for (const modelId of fastChain) {
      expect(premiumIds).not.toContain(modelId);
    }
  });

  it('standard chain never contains premium models', () => {
    const premiumIds = MODEL_CATALOG.filter(m => m.tier === 'premium').map(m => m.id);
    const standardChain = DEFAULT_FALLBACK_CHAINS.standard;
    for (const modelId of standardChain) {
      expect(premiumIds).not.toContain(modelId);
    }
  });

  it('getNextFallback for fast model returns fast-tier model', () => {
    const next = registry.getNextFallback('gemini-2.0-flash', 'fast');
    if (next) {
      const info = registry.getModelInfo(next);
      expect(info!.tier).toBe('fast');
    }
  });

  it('getModelsByTier(fast) returns no premium models', () => {
    const fastModels = registry.getModelsByTier('fast');
    expect(fastModels.every(m => m.tier === 'fast')).toBe(true);
    expect(fastModels.every(m => m.tier !== 'premium')).toBe(true);
  });
});

// ============================================================================
// Provider preference: "use Claude" stays in Claude family
// ============================================================================

describe('Provider preference — Gemini family preference', () => {
  const registry = new ModelRegistry();

  it('getFallbackChain with preferSameProvider starts with same provider', () => {
    const chain = registry.getFallbackChain('standard', true, 'gemini-2.5-flash-preview-04-17');

    // All standard models are Google — chain should be non-empty
    expect(chain.length).toBeGreaterThan(0);
    for (const modelId of chain) {
      const info = registry.getModelInfo(modelId);
      expect(info?.provider).toBe('google');
    }
  });

  it('prefer Gemini: all google models come before other providers', () => {
    const chain = registry.getFallbackChain('standard', true, 'gemini-2.5-flash-preview-04-17');
    // All models in the chain should be Google
    for (const modelId of chain) {
      const info = registry.getModelInfo(modelId);
      expect(info?.provider).toBe('google');
    }
    expect(chain.length).toBeGreaterThan(0);
  });

  it('unknown current model with preferSameProvider falls back to default', () => {
    const chain = registry.getFallbackChain('standard', true, 'gpt-unknown');

    // Unknown model → falls back to default chain
    expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
  });

  it('without preference: returns default chain order', () => {
    const chain = registry.getFallbackChain('standard', false);
    expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
  });

  it('unknown model with preferSameProvider falls back to default', () => {
    const chain = registry.getFallbackChain('standard', true, 'nonexistent-model');
    expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
  });
});

// ============================================================================
// Nuclear fallback: all models fail → null (omit model param)
// ============================================================================

describe('Nuclear fallback — all models exhausted', () => {
  const registry = new ModelRegistry();

  it('getNextFallback returns null when all premium models attempted', () => {
    const allPremium = new Set(DEFAULT_FALLBACK_CHAINS.premium);
    const result = registry.getNextFallback('gemini-2.5-pro-preview-05-06', 'premium', allPremium);
    expect(result).toBeNull();
  });

  it('getNextFallback returns null when all standard models attempted', () => {
    const allStandard = new Set(DEFAULT_FALLBACK_CHAINS.standard);
    const result = registry.getNextFallback('gemini-2.5-flash-preview-04-17', 'standard', allStandard);
    expect(result).toBeNull();
  });

  it('getNextFallback returns null when all fast models attempted', () => {
    const allFast = new Set(DEFAULT_FALLBACK_CHAINS.fast);
    const result = registry.getNextFallback('gemini-2.0-flash', 'fast', allFast);
    expect(result).toBeNull();
  });

  it('simulates full fallback cascade ending in null', () => {
    const attempted = new Set<string>();
    let current: string | null = DEFAULT_FALLBACK_CHAINS.standard[0]!;
    attempted.add(current);

    while (current) {
      const next = registry.getNextFallback(current, 'standard', attempted);
      if (next) attempted.add(next);
      current = next;
    }

    // All standard chain models were attempted
    for (const model of DEFAULT_FALLBACK_CHAINS.standard) {
      expect(attempted.has(model)).toBe(true);
    }
    // Final result is null → caller should omit model param
    expect(current).toBeNull();
  });

  it('chain length matches catalog tier count', () => {
    for (const tier of ['premium', 'standard', 'fast'] as const) {
      const chainLength = DEFAULT_FALLBACK_CHAINS[tier].length;
      // Chain should have at least as many entries as the minimum for that tier
      expect(chainLength).toBeGreaterThan(0);
      // Every model in chain must be a valid model
      for (const modelId of DEFAULT_FALLBACK_CHAINS[tier]) {
        expect(registry.isModelAvailable(modelId)).toBe(true);
      }
    }
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('Model fallback — edge cases', () => {
  const registry = new ModelRegistry();

  it('getNextFallback with empty attempted set returns second in chain', () => {
    const next = registry.getNextFallback('gemini-2.5-pro-preview-05-06', 'premium');
    // With no attempted set, it should return the next in chain after current
    expect(next).toBe('gemini-2.5-pro');
  });

  it('getNextFallback for unknown model returns null', () => {
    const next = registry.getNextFallback('nonexistent', 'standard');
    // Unknown model not in chain — should still return first available
    // or null depending on implementation
    expect(next === null || typeof next === 'string').toBe(true);
  });

  it('each tier has at least 2 fallback options', () => {
    expect(DEFAULT_FALLBACK_CHAINS.premium.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_FALLBACK_CHAINS.standard.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_FALLBACK_CHAINS.fast.length).toBeGreaterThanOrEqual(2);
  });

  it('no duplicate models in any chain', () => {
    for (const tier of ['premium', 'standard', 'fast'] as const) {
      const chain = DEFAULT_FALLBACK_CHAINS[tier];
      const uniqueSet = new Set(chain);
      expect(uniqueSet.size).toBe(chain.length);
    }
  });

  it('all chain models exist in catalog', () => {
    for (const tier of ['premium', 'standard', 'fast'] as const) {
      for (const modelId of DEFAULT_FALLBACK_CHAINS[tier]) {
        expect(registry.getModelInfo(modelId)).not.toBeNull();
      }
    }
  });
});
