/**
 * The variant grammar, which is how an experiment gets written down.
 *
 * Worth pinning because every part of it is silent when wrong: a model that
 * fails to parse falls back to the tier alias and the run still happens, on a
 * different model, under a name that claims otherwise.
 */

import { describe, it, expect } from 'vitest';

import { parseVariants } from '../packages/squad-lab/src/variants.js';

describe('parseVariants', () => {
  it('reads a bare provider', () => {
    expect(parseVariants('anthropic,gemini')).toEqual([
      { provider: 'anthropic' },
      { provider: 'gemini' },
    ]);
  });

  it('keeps the tier grammar working', () => {
    expect(parseVariants('anthropic:premium,gemini:fast')).toEqual([
      { provider: 'anthropic', tier: 'premium' },
      { provider: 'gemini', tier: 'fast' },
    ]);
  });

  it('pins a model', () => {
    expect(parseVariants('anthropic@claude-sonnet-5')).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    ]);
  });

  it('names a harness per variant', () => {
    expect(parseVariants('anthropic@claude-sonnet-5/ai-sdk')).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5', harnessImpl: 'ai-sdk' },
    ]);
  });

  it('combines tier, model and harness', () => {
    expect(parseVariants('gemini:standard@gemini-flash-latest/squad-native')).toEqual([
      {
        provider: 'gemini',
        tier: 'standard',
        model: 'gemini-flash-latest',
        harnessImpl: 'squad-native',
      },
    ]);
  });

  it('writes the four-cell matrix this lab exists for', () => {
    const parsed = parseVariants(
      'anthropic@claude-sonnet-5/squad-native,anthropic@claude-sonnet-5/ai-sdk,' +
        'gemini@gemini-flash-latest/squad-native,gemini@gemini-flash-latest/ai-sdk',
    );
    expect(parsed).toHaveLength(4);
    // One model per vendor, each under both arms — so any difference within a
    // vendor is the harness and not the model.
    expect(new Set(parsed.map((v) => v.model))).toEqual(
      new Set(['claude-sonnet-5', 'gemini-flash-latest']),
    );
    expect(new Set(parsed.map((v) => v.harnessImpl))).toEqual(
      new Set(['squad-native', 'ai-sdk']),
    );
  });

  it('splits on the first separator, so a dated model id survives', () => {
    // The registry's policy is aliases; a pinned id is exactly what this field
    // is for, and those carry dots and dashes.
    expect(parseVariants('anthropic@claude-sonnet-4-5-20250929')).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    ]);
  });

  it('ignores whitespace and empty entries', () => {
    expect(parseVariants(' anthropic , , gemini ')).toEqual([
      { provider: 'anthropic' },
      { provider: 'gemini' },
    ]);
  });
});
