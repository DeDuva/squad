/**
 * The variant grammar: how one cell of an experiment is written down.
 *
 * Its own module rather than a helper in `cli.ts` because `cli.ts` runs its
 * command on import, and a grammar nothing can test is a grammar that drifts.
 */

import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

import type { HarnessImpl } from './harness.js';

export interface ParsedVariant {
  provider: SquadProvider;
  tier?: 'premium' | 'standard' | 'fast';
  model?: string;
  harnessImpl?: HarnessImpl;
}

/**
 * `provider[:tier][@model][/harness]`, comma-separated.
 *
 * `anthropic` · `anthropic:premium` · `anthropic@claude-sonnet-5` ·
 * `anthropic@claude-sonnet-5/ai-sdk`
 *
 * The last two exist so the comparison this lab is for can be written down: one
 * model, pinned by id rather than left to a tier alias that moves under it, run
 * under both harnesses in a single experiment. A tier alone still works and
 * still means "whatever the registry calls that tier today" — the right default
 * for a first run, and the wrong one for a result you intend to cite.
 */
export function parseVariants(spec: string): ParsedVariant[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [beforeHarness, harnessImpl] = splitOnce(s, '/');
      const [beforeModel, model] = splitOnce(beforeHarness, '@');
      const [provider, tier] = splitOnce(beforeModel, ':');
      return {
        provider: provider as SquadProvider,
        ...(tier ? { tier: tier as 'premium' | 'standard' | 'fast' } : {}),
        ...(model ? { model } : {}),
        ...(harnessImpl ? { harnessImpl: harnessImpl as HarnessImpl } : {}),
      };
    });
}

/**
 * Split on the first separator only.
 *
 * Model ids carry dots, dashes and digits and may one day carry a slash; the
 * separator that comes first is the one that was meant.
 */
function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}
