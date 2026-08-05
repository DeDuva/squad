/**
 * Invariants of the vendor registry.
 *
 * The registry exists so that "which vendor is the default" and "which model is
 * the latest" each have exactly one answer. These tests are what stop those
 * answers from drifting apart again — the previous arrangement had the default
 * provider set to Anthropic in one file while the model constants handed out
 * Gemini ids in another, and nothing noticed.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROVIDER,
  KNOWN_PROVIDERS,
  VENDORS,
  defaultVendor,
  isPinnedModelId,
  providerForModel,
} from '../packages/squad-sdk/src/config/vendors.js';
import { MODELS } from '../packages/squad-sdk/src/runtime/constants.js';
import {
  DEFAULT_FALLBACK_CHAINS,
  FALLBACK_CHAINS_BY_PROVIDER,
  MODEL_CATALOG,
  asProvider,
} from '../packages/squad-sdk/src/config/models.js';

const TIERS = ['premium', 'standard', 'fast'] as const;

describe('the vendor registry', () => {
  // The whole point of the registry: a model id that names a frozen version is
  // correct only until the vendor ships the next one, and then it silently
  // keeps working while getting worse. That failure is invisible in production,
  // so it has to be caught here.
  it('names only unpinned model aliases, never a frozen version', () => {
    for (const vendor of Object.values(VENDORS)) {
      const ids = [
        ...Object.values(vendor.models),
        ...Object.values(vendor.fallbackChains).flat(),
        vendor.nuclearFallback,
      ];
      for (const id of ids) {
        expect(isPinnedModelId(vendor.id, id), `${vendor.id}: ${id} is version-pinned`).toBe(false);
      }
    }
  });

  it('recognizes each vendor’s own pinning convention', () => {
    // The vendors disagree about what a version looks like, which is why the
    // pattern is per-vendor rather than one shared regex: a date suffix pins a
    // Claude id, while `claude-haiku-4-5` is an alias that happens to carry a
    // version in its name.
    expect(isPinnedModelId('anthropic', 'claude-sonnet-5-20260101')).toBe(true);
    expect(isPinnedModelId('anthropic', 'claude-haiku-4-5')).toBe(false);
    // Google pins with a generation number; `-latest` follows the releases.
    expect(isPinnedModelId('gemini', 'gemini-2.5-flash')).toBe(true);
    expect(isPinnedModelId('gemini', 'gemini-flash-latest')).toBe(false);
  });

  it('covers every tier for every vendor, with chains that end somewhere', () => {
    for (const vendor of Object.values(VENDORS)) {
      for (const tier of TIERS) {
        expect(vendor.models[tier], `${vendor.id}.models.${tier}`).toBeTruthy();
        expect(vendor.fallbackChains[tier].length, `${vendor.id}.chains.${tier}`).toBeGreaterThan(0);
      }
    }
  });

  // A chain that crosses vendors would name a model the session's backend
  // cannot serve, so the "fallback" fails at the transport instead of degrading.
  it('keeps fallback chains inside one vendor', () => {
    for (const vendor of Object.values(VENDORS)) {
      for (const tier of TIERS) {
        for (const model of vendor.fallbackChains[tier]) {
          expect(providerForModel(model), `${model} in ${vendor.id}.${tier}`).toBe(vendor.id);
        }
      }
    }
  });

  it('lists every registered vendor as a known provider', () => {
    expect(new Set(KNOWN_PROVIDERS)).toEqual(new Set(Object.keys(VENDORS)));
    for (const provider of KNOWN_PROVIDERS) {
      expect(asProvider(provider)).toBe(provider);
    }
    expect(asProvider('not-a-vendor')).toBeNull();
  });

  it('describes every model it names in the catalog', () => {
    const catalogued = new Set(MODEL_CATALOG.map((m) => m.id));
    for (const vendor of Object.values(VENDORS)) {
      for (const tier of TIERS) {
        expect(catalogued, `${vendor.id}.models.${tier}`).toContain(vendor.models[tier]);
      }
    }
  });
});

describe('the default vendor', () => {
  // The defect this whole change exists to fix: the provider default and the
  // model constants were set in different files and disagreed, so the default
  // configuration sent Gemini model ids to the Claude backend.
  it('is the one the model constants hand out', () => {
    const vendor = defaultVendor();
    expect(MODELS.SELECTOR_DEFAULT).toBe(vendor.models.standard);
    expect(MODELS.NUCLEAR_FALLBACK).toBe(vendor.nuclearFallback);
    expect(MODELS.FALLBACK_CHAINS).toEqual(vendor.fallbackChains);
    for (const model of Object.values(MODELS.FALLBACK_CHAINS).flat()) {
      expect(providerForModel(model)).toBe(DEFAULT_PROVIDER);
    }
  });

  it('is the one the default fallback chains degrade through', () => {
    expect(DEFAULT_FALLBACK_CHAINS).toEqual(FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER]);
  });

  // Not an assertion that Anthropic must stay the default — it's that a change
  // of default is a one-line edit whose effects reach every derived value.
  // If this fails because DEFAULT_PROVIDER moved, update the expectation.
  it('is Anthropic, with Claude as the standard model', () => {
    expect(DEFAULT_PROVIDER).toBe('anthropic');
    expect(MODELS.DEFAULT).toBe('claude-sonnet-5');
  });
});
