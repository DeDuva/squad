/**
 * Tests for models configuration module
 */

import { describe, it, expect } from 'vitest';
import {
  ModelRegistry,
  MODEL_CATALOG,
  DEFAULT_FALLBACK_CHAINS,
  getModelInfo,
  getFallbackChain,
  isModelAvailable
} from '@deduvafork/squad-sdk/config';

describe('MODEL_CATALOG', () => {
  it('contains premium and standard tiers', () => {
    const premiumModels = MODEL_CATALOG.filter(m => m.tier === 'premium');
    const standardModels = MODEL_CATALOG.filter(m => m.tier === 'standard');

    expect(premiumModels.length).toBeGreaterThan(0);
    expect(standardModels.length).toBeGreaterThan(0);
  });

  it('includes expected premium models', () => {
    const modelIds = MODEL_CATALOG.map(m => m.id);

    expect(modelIds).toContain('gemini-pro-latest');
  });

  it('includes expected flash model', () => {
    const modelIds = MODEL_CATALOG.map(m => m.id);

    expect(modelIds).toContain('gemini-flash-latest');
  });

  it('assigns correct providers', () => {
    const pro = MODEL_CATALOG.find(m => m.id === 'gemini-pro-latest');
    const flash = MODEL_CATALOG.find(m => m.id === 'gemini-flash-latest');

    expect(pro?.provider).toBe('google');
    expect(flash?.provider).toBe('google');
  });
});

describe('DEFAULT_FALLBACK_CHAINS', () => {
  it('defines chains for all tiers', () => {
    expect(DEFAULT_FALLBACK_CHAINS.premium).toBeDefined();
    expect(DEFAULT_FALLBACK_CHAINS.standard).toBeDefined();
    expect(DEFAULT_FALLBACK_CHAINS.fast).toBeDefined();
  });

  it('has non-empty chains', () => {
    expect(DEFAULT_FALLBACK_CHAINS.premium.length).toBeGreaterThan(0);
    expect(DEFAULT_FALLBACK_CHAINS.standard.length).toBeGreaterThan(0);
    expect(DEFAULT_FALLBACK_CHAINS.fast.length).toBeGreaterThan(0);
  });

  it('starts premium chain with gemini pro', () => {
    expect(DEFAULT_FALLBACK_CHAINS.premium[0]).toBe('gemini-pro-latest');
  });

  it('starts standard chain with gemini flash', () => {
    expect(DEFAULT_FALLBACK_CHAINS.standard[0]).toBe('gemini-flash-latest');
  });

  it('starts fast chain with gemini flash', () => {
    expect(DEFAULT_FALLBACK_CHAINS.fast[0]).toBe('gemini-flash-latest');
  });
});

describe('ModelRegistry', () => {
  const registry = new ModelRegistry();

  describe('getModelInfo', () => {
    it('returns info for valid model', () => {
      const info = registry.getModelInfo('gemini-flash-latest');

      expect(info).toBeDefined();
      expect(info?.id).toBe('gemini-flash-latest');
      expect(info?.tier).toBe('standard');
      expect(info?.provider).toBe('google');
    });

    it('returns null for unknown model', () => {
      const info = registry.getModelInfo('unknown-model-xyz');

      expect(info).toBeNull();
    });
  });

  describe('isModelAvailable', () => {
    it('returns true for catalog models', () => {
      expect(registry.isModelAvailable('gemini-pro-latest')).toBe(true);
      expect(registry.isModelAvailable('gemini-flash-latest')).toBe(true);
    });

    it('returns false for unknown models', () => {
      expect(registry.isModelAvailable('gpt-6')).toBe(false);
      expect(registry.isModelAvailable('claude-ultra-5')).toBe(false);
    });
  });

  describe('getModelsByTier', () => {
    it('returns all premium models', () => {
      const premiumModels = registry.getModelsByTier('premium');

      expect(premiumModels.length).toBeGreaterThan(0);
      expect(premiumModels.every(m => m.tier === 'premium')).toBe(true);
    });

    it('returns all standard models', () => {
      const standardModels = registry.getModelsByTier('standard');

      expect(standardModels.length).toBeGreaterThan(0);
      expect(standardModels.every(m => m.tier === 'standard')).toBe(true);
    });
  });

  describe('getModelsByProvider', () => {
    it('returns google models', () => {
      const models = registry.getModelsByProvider('google');

      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'google')).toBe(true);
      expect(models.some(m => m.id.includes('gemini'))).toBe(true);
    });

    it('returns empty array for unknown provider', () => {
      const models = registry.getModelsByProvider('anthropic');

      expect(models.length).toBe(0);
    });
  });

  describe('getFallbackChain', () => {
    it('returns default chain without preferences', () => {
      const chain = registry.getFallbackChain('standard', false);

      expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
    });

    it('prefers same provider when enabled', () => {
      const chain = registry.getFallbackChain('standard', true, 'gemini-flash-latest');

      expect(chain.length).toBeGreaterThan(0);
      const info = chain.map(id => registry.getModelInfo(id));
      expect(info.every(m => m?.provider === 'google')).toBe(true);
    });

    it('handles unknown current model gracefully', () => {
      const chain = registry.getFallbackChain('standard', true, 'unknown-model');

      expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
    });
  });

  describe('getNextFallback', () => {
    it('returns next model in chain', () => {
      const next = registry.getNextFallback('gemini-pro-latest', 'premium');

      expect(next).toBe('gemini-flash-latest');
    });

    it('skips already attempted models', () => {
      const attempted = new Set<string>(['gemini-flash-latest']);
      const next = registry.getNextFallback('gemini-pro-latest', 'premium', attempted);

      // All models in premium chain have been attempted
      expect(next).toBeNull();
    });

    it('returns null when chain exhausted', () => {
      const allModels = new Set(DEFAULT_FALLBACK_CHAINS.premium);
      const next = registry.getNextFallback('gemini-pro-latest', 'premium', allModels);

      expect(next).toBeNull();
    });
  });

  describe('getRecommendedModels', () => {
    it('recommends models for code generation', () => {
      const recommended = registry.getRecommendedModels('code generation');

      expect(recommended.length).toBeGreaterThan(0);
      expect(recommended.some(m => m.id.includes('flash'))).toBe(true);
    });

    it('recommends models for specific use case', () => {
      const recommended = registry.getRecommendedModels('architecture proposals');

      expect(recommended.length).toBeGreaterThan(0);
      expect(recommended.some(m => m.tier === 'premium')).toBe(true);
    });

    it('filters by tier when specified', () => {
      const recommended = registry.getRecommendedModels('code', 'standard');

      expect(recommended.every(m => m.tier === 'standard')).toBe(true);
    });
  });

  describe('getAllModelIds', () => {
    it('returns all model IDs', () => {
      const ids = registry.getAllModelIds();

      expect(ids.length).toBe(MODEL_CATALOG.length);
      expect(ids).toContain('gemini-pro-latest');
      expect(ids).toContain('gemini-flash-latest');
    });
  });

  describe('getStats', () => {
    it('returns accurate statistics', () => {
      const stats = registry.getStats();

      expect(stats.total).toBe(MODEL_CATALOG.length);
      expect(stats.byTier.premium).toBeGreaterThan(0);
      expect(stats.byTier.standard).toBeGreaterThan(0);
      expect(stats.byProvider.google).toBeGreaterThan(0);
    });
  });
});

describe('convenience functions', () => {
  it('getModelInfo works', () => {
    const info = getModelInfo('gemini-flash-latest');

    expect(info).toBeDefined();
    expect(info?.id).toBe('gemini-flash-latest');
  });

  it('getFallbackChain works', () => {
    const chain = getFallbackChain('standard');

    expect(chain).toEqual(DEFAULT_FALLBACK_CHAINS.standard);
  });

  it('isModelAvailable works', () => {
    expect(isModelAvailable('gemini-pro-latest')).toBe(true);
    expect(isModelAvailable('nonexistent-model')).toBe(false);
  });
});
