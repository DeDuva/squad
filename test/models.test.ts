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
  isModelAvailable,
  estimateCost,
  resolveModel,
  FALLBACK_CHAINS_BY_PROVIDER
} from '@deduvafork/squad-sdk/config';
// From source, the way test/vendors.test.ts reaches it: the vendor registry is
// not re-exported through the `config` entrypoint.
import { DEFAULT_PROVIDER } from '../packages/squad-sdk/src/config/vendors.js';

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

  // Written against the default vendor's own chains rather than a hardcoded
  // model id. These named one vendor's models, so flipping DEFAULT_PROVIDER
  // broke them with nothing actually wrong — the invariant worth pinning is
  // that the default chains *are* the default vendor's.
  it('starts premium chain with the default vendor premium model', () => {
    expect(DEFAULT_FALLBACK_CHAINS.premium[0]).toBe(
      FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER].premium[0],
    );
  });

  it('starts standard chain with the default vendor standard model', () => {
    expect(DEFAULT_FALLBACK_CHAINS.standard[0]).toBe(
      FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER].standard[0],
    );
  });

  it('starts fast chain with the default vendor fast model', () => {
    expect(DEFAULT_FALLBACK_CHAINS.fast[0]).toBe(
      FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER].fast[0],
    );
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

    it('returns anthropic models', () => {
      const models = registry.getModelsByProvider('anthropic');

      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'anthropic')).toBe(true);
      expect(models.every(m => m.family === 'claude')).toBe(true);
    });

    it('returns empty array for a provider with no catalog entries', () => {
      // 'openai' is in the ModelInfo provider union but has no entries — this
      // asserts the empty-result path, which used to be covered by 'anthropic'
      // back when the catalog was Gemini-only.
      const models = registry.getModelsByProvider('openai');

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
      // The exhausted set has to be the chain this model actually walks — its
      // own vendor's — now that the default chains belong to the other vendor.
      const allModels = new Set(FALLBACK_CHAINS_BY_PROVIDER.gemini.premium);
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

describe('Anthropic catalog entries', () => {
  const anthropicIds = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

  it.each(anthropicIds)('%s is in the catalog and is priced', (id) => {
    const info = getModelInfo(id);

    expect(info).toBeDefined();
    expect(info!.provider).toBe('anthropic');
    expect(info!.pricing).toBeDefined();
    expect(info!.pricing!.inputPerToken).toBeGreaterThan(0);
    expect(info!.pricing!.outputPerToken).toBeGreaterThan(0);
  });

  it('prices output above input for every priced model', () => {
    // True of every Anthropic and Gemini rate card. A model where this
    // inverts is far more likely a transcription slip than a real price.
    for (const m of MODEL_CATALOG.filter(m => m.pricing)) {
      expect(m.pricing!.outputPerToken).toBeGreaterThan(m.pricing!.inputPerToken);
    }
  });

  it('orders the tiers by cost: opus > sonnet > haiku', () => {
    const price = (id: string) => getModelInfo(id)!.pricing!.inputPerToken;

    expect(price('claude-opus-5')).toBeGreaterThan(price('claude-sonnet-5'));
    expect(price('claude-sonnet-5')).toBeGreaterThan(price('claude-haiku-4-5'));
  });
});

describe('estimateCost', () => {
  it('returns a real, non-zero cost for a priced model', () => {
    // 1M in + 1M out on opus-5 at $5/$25 per MTok.
    expect(estimateCost('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
  });

  it('scales linearly with token counts', () => {
    const single = estimateCost('claude-sonnet-5', 1000, 500);
    const double = estimateCost('claude-sonnet-5', 2000, 1000);

    expect(double).toBeCloseTo(single * 2, 10);
  });

  it('returns 0 for an unpriced model rather than throwing', () => {
    // The Gemini aliases are deliberately unpriced — see the catalog comment.
    expect(estimateCost('gemini-flash-latest', 1000, 1000)).toBe(0);
  });

  it('returns 0 for an unknown model', () => {
    expect(estimateCost('nonexistent-model', 1000, 1000)).toBe(0);
  });
});

describe('FALLBACK_CHAINS_BY_PROVIDER', () => {
  it('never crosses providers within a chain', () => {
    // A session is bound to one backend, so a cross-provider fallback would
    // fail at the transport layer instead of degrading.
    for (const [provider, chains] of Object.entries(FALLBACK_CHAINS_BY_PROVIDER)) {
      for (const chain of Object.values(chains)) {
        for (const id of chain) {
          expect(getModelInfo(id)?.provider).toBe(provider === 'gemini' ? 'google' : provider);
        }
      }
    }
  });

  it('points DEFAULT_FALLBACK_CHAINS at the default vendor', () => {
    // Was asserted against the Gemini chains "for back-compat". That promise
    // was deliberately dropped when the default became one line in the vendor
    // registry, so the test now pins the rule that replaced it: whichever
    // vendor is default supplies the default chains.
    expect(DEFAULT_FALLBACK_CHAINS).toEqual(FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER]);
  });
});

describe('resolveModel provider-awareness', () => {
  it('defaults to the Gemini standard tier when no provider is given', () => {
    expect(resolveModel({})).toBe('gemini-flash-latest');
  });

  it('defaults to the Anthropic standard tier for provider anthropic', () => {
    expect(resolveModel({ provider: 'anthropic' })).toBe('claude-sonnet-5');
  });

  it('downgrades the Anthropic default under economy mode', () => {
    expect(resolveModel({ provider: 'anthropic', economyMode: true })).toBe('claude-haiku-4-5');
  });

  it('never rewrites an explicit choice to match the provider', () => {
    // Layers 0-2 are the caller's explicit decision. Silently swapping them
    // would hide a real misconfiguration behind a model that happens to load.
    expect(resolveModel({ provider: 'anthropic', sessionDirective: 'gemini-pro-latest' }))
      .toBe('gemini-pro-latest');
  });
});
