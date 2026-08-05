/**
 * The model vendors squad can run on, and which one is the default.
 *
 * **This module is the single source of truth for both.** Adding a vendor is an
 * entry in {@link VENDORS} plus a backend client and one line in the loader map
 * in `adapter/backend-factory.ts` (which is typed `Record<SquadProvider, …>`, so
 * the compiler will tell you if you forget). Changing which vendor is the
 * default is one edit to {@link DEFAULT_PROVIDER} — the model constants,
 * fallback chains, and backend resolution all derive from it rather than
 * repeating a model id.
 *
 * It has **no runtime imports on purpose**. Everything that needs vendor data
 * imports it, including `runtime/constants.ts`, which is itself imported almost
 * everywhere — a runtime dependency here would close an import cycle.
 *
 * @module config/vendors
 */

import type { SquadProvider } from '../adapter/backend.js';
import type { ModelId, ModelTier } from '../runtime/config.js';

export interface VendorDefinition {
  id: SquadProvider;
  /** Human-readable name, for CLI output and error messages. */
  displayName: string;
  /**
   * The model to use for each tier.
   *
   * **Aliases only — never a pinned version.** A pinned id is correct for
   * exactly as long as it takes the vendor to ship the next model, and then it
   * quietly keeps working while getting worse. Every id here must be the form
   * that always resolves to the current release, which is
   * `claude-sonnet-5` for Anthropic (their ids are already unpinned — a date
   * suffix is what pins one) and `gemini-flash-latest` for Google.
   * {@link isPinnedModelId} enforces this, and a test asserts it over the
   * whole registry.
   */
  models: Record<ModelTier, ModelId>;
  /**
   * Ordered degradation path per tier. Chains never cross vendors: a session is
   * bound to one backend, so falling back from Claude to Gemini would fail at
   * the transport rather than degrade.
   */
  fallbackChains: Record<ModelTier, ModelId[]>;
  /** Last resort when every chain is exhausted. */
  nuclearFallback: ModelId;
  /** Environment variable carrying this vendor's API key. */
  apiKeyEnv: string;
  /**
   * What a *pinned* model id looks like for this vendor.
   *
   * Per-vendor rather than one clever regex, because the vendors disagree about
   * what a version looks like: `claude-haiku-4-5` is an alias with a version in
   * the name, while `gemini-2.5-flash` is a pin. Only the vendor knows which of
   * its own shapes moves with releases.
   */
  pinnedModelPattern: RegExp;
}

/**
 * The vendor squad uses when nothing else selects one.
 *
 * Change this line to change the default everywhere — models, fallback chains,
 * and which backend `createBackend` builds.
 */
export const DEFAULT_PROVIDER: SquadProvider = 'anthropic';

export const VENDORS: Record<SquadProvider, VendorDefinition> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    models: {
      premium: 'claude-opus-5',
      standard: 'claude-sonnet-5',
      fast: 'claude-haiku-4-5',
    },
    fallbackChains: {
      premium: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
      standard: ['claude-sonnet-5', 'claude-haiku-4-5'],
      fast: ['claude-haiku-4-5'],
    },
    nuclearFallback: 'claude-haiku-4-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    // Anthropic's published ids are already the unpinned form; appending a
    // dated snapshot suffix is what pins one.
    pinnedModelPattern: /-\d{8}$/,
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    models: {
      premium: 'gemini-pro-latest',
      standard: 'gemini-flash-latest',
      fast: 'gemini-flash-latest',
    },
    fallbackChains: {
      premium: ['gemini-pro-latest', 'gemini-flash-latest'],
      standard: ['gemini-flash-latest'],
      fast: ['gemini-flash-latest'],
    },
    nuclearFallback: 'gemini-flash-latest',
    apiKeyEnv: 'GEMINI_API_KEY',
    // Google pins with a numeric generation in the id — `gemini-2.5-flash`
    // stays on 2.5 forever, while `gemini-flash-latest` follows the releases.
    pinnedModelPattern: /\d+\.\d+/,
  },
};

/** Every vendor squad knows how to talk to. */
export const KNOWN_PROVIDERS = Object.keys(VENDORS) as SquadProvider[];

export function vendorFor(provider: SquadProvider): VendorDefinition {
  return VENDORS[provider];
}

/** The default vendor's definition. */
export function defaultVendor(): VendorDefinition {
  return VENDORS[DEFAULT_PROVIDER];
}

/**
 * Whether a model id names a frozen version rather than tracking the latest.
 *
 * Used to keep the registry honest, and worth calling on any model id that
 * arrives from configuration: pinning is rarely deliberate, and it is invisible
 * until someone notices the fleet has been running a superseded model for
 * months.
 */
export function isPinnedModelId(provider: SquadProvider, model: ModelId): boolean {
  return VENDORS[provider].pinnedModelPattern.test(model);
}

/**
 * The vendor a model id belongs to, by prefix, or undefined when no vendor
 * claims it. Deliberately prefix-based rather than a catalog lookup, so it
 * still answers for a model released after this build.
 */
export function providerForModel(model: ModelId): SquadProvider | undefined {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  return undefined;
}
