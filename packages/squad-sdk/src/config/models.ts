/**
 * Model Configuration & Registry
 * 
 * Defines the full model catalog and provides model lookup, fallback chains,
 * and availability checking. Implements the model tier system from squad.agent.md.
 * 
 * @module config/models
 */

import { join } from 'path';
import type { StorageProvider } from '../storage/index.js';
import { FSStorageProvider } from '../storage/index.js';
import type { ModelId, ModelTier } from '../runtime/config.js';
import type { SquadProvider } from '../adapter/backend.js';
import { DEFAULT_PROVIDER, KNOWN_PROVIDERS, VENDORS } from './vendors.js';
import type { SquadReasoningEffort } from '../adapter/types.js';

/**
 * Per-token pricing in USD.
 */
export interface ModelPricing {
  /** Cost per input token in USD */
  inputPerToken: number;
  /** Cost per output token in USD */
  outputPerToken: number;
}

/**
 * Model capability information.
 */
export interface ModelInfo {
  /** Model identifier */
  id: ModelId;
  
  /** Model tier */
  tier: ModelTier;
  
  /** Provider (anthropic, openai, google) */
  provider: 'anthropic' | 'openai' | 'google';
  
  /** Model family */
  family: 'claude' | 'gpt' | 'gemini';
  
  /** Supports vision/multimodal input */
  vision?: boolean;
  
  /** Typical use cases */
  useCases?: string[];
  
  /** Relative cost (1-10 scale, 10 = most expensive) */
  cost?: number;
  
  /** Relative speed (1-10 scale, 10 = fastest) */
  speed?: number;

  /** Per-token pricing in USD (if known) */
  pricing?: ModelPricing;
}

/**
 * Full model catalog.
 *
 * Anthropic is the default provider; Gemini remains selectable behind the
 * provider switch (see `adapter/backend-factory.ts`).
 */
export const MODEL_CATALOG: ModelInfo[] = [
  // -------------------------------------------------------------------------
  // Anthropic — default provider
  // Pricing is per-token USD, converted from the published per-million rates.
  // -------------------------------------------------------------------------

  // Premium tier
  {
    id: 'claude-opus-5',
    tier: 'premium',
    provider: 'anthropic',
    family: 'claude',
    vision: true,
    useCases: ['architecture proposals', 'security audits', 'complex design', 'deep reasoning', 'reviewer gates', 'long context', 'long-horizon agentic work'],
    cost: 8,
    speed: 5,
    // $5 / $25 per million tokens.
    pricing: { inputPerToken: 5e-6, outputPerToken: 25e-6 },
  },

  // Standard tier
  {
    id: 'claude-sonnet-5',
    tier: 'standard',
    provider: 'anthropic',
    family: 'claude',
    vision: true,
    useCases: ['code generation', 'test writing', 'refactoring', 'agentic coding', 'code review', 'boilerplate'],
    cost: 5,
    speed: 7,
    // $3 / $15 per million tokens. An introductory rate of $2 / $10 runs
    // through 2026-08-31; the standard rate is used here so estimates don't
    // silently under-report once the promotion ends.
    pricing: { inputPerToken: 3e-6, outputPerToken: 15e-6 },
  },

  // Fast tier
  {
    id: 'claude-haiku-4-5',
    tier: 'fast',
    provider: 'anthropic',
    family: 'claude',
    vision: true,
    useCases: ['triage', 'classification', 'changelogs', 'simple fixes', 'summarization'],
    cost: 2,
    speed: 9,
    // $1 / $5 per million tokens.
    pricing: { inputPerToken: 1e-6, outputPerToken: 5e-6 },
  },

  // -------------------------------------------------------------------------
  // Gemini — selectable via `squad config provider gemini`
  // Version-free aliases that always resolve to the latest stable build.
  //
  // Deliberately unpriced: the alias moves with each stable release, so any
  // rate hardcoded here is wrong the moment it does. `estimateCost` returns 0
  // for these, which is the pre-existing behaviour. The Anthropic path does
  // not depend on this — its backend reports real spend per turn.
  // -------------------------------------------------------------------------

  // Premium tier
  {
    id: 'gemini-pro-latest',
    tier: 'premium',
    provider: 'google',
    family: 'gemini',
    vision: true,
    useCases: ['architecture proposals', 'security audits', 'complex design', 'deep reasoning', 'reviewer gates', 'long context'],
    cost: 8,
    speed: 4,
  },

  // Standard / fast tier
  {
    id: 'gemini-flash-latest',
    tier: 'standard',
    provider: 'google',
    family: 'gemini',
    vision: true,
    useCases: ['code generation', 'test writing', 'refactoring', 'prompt engineering', 'boilerplate', 'changelogs', 'simple fixes', 'triage'],
    cost: 3,
    speed: 8,
  },
];

/**
 * Default fallback chains per tier, per provider.
 *
 * Chains never cross providers: a session is bound to one backend, so falling
 * back from a Claude model to a Gemini one would fail at the transport layer
 * rather than degrade gracefully.
 */
export const FALLBACK_CHAINS_BY_PROVIDER: Record<SquadProvider, Record<ModelTier, ModelId[]>> =
  Object.fromEntries(Object.values(VENDORS).map((v) => [v.id, v.fallbackChains])) as Record<
    SquadProvider,
    Record<ModelTier, ModelId[]>
  >;

/**
 * Default fallback chains per tier — the default vendor's.
 *
 * These used to point at the Gemini chains regardless of which provider was
 * default, so a Claude session's degradation path named models its backend
 * could not serve. Following {@link DEFAULT_PROVIDER} is what makes the chains
 * usable; provider-aware callers should still read
 * {@link FALLBACK_CHAINS_BY_PROVIDER}.
 */
export const DEFAULT_FALLBACK_CHAINS: Record<ModelTier, ModelId[]> =
  FALLBACK_CHAINS_BY_PROVIDER[DEFAULT_PROVIDER];

/**
 * Model registry for lookups and availability checking.
 */
export class ModelRegistry {
  private catalog: Map<ModelId, ModelInfo>;
  private tierIndex: Map<ModelTier, ModelInfo[]>;
  private providerIndex: Map<string, ModelInfo[]>;
  
  constructor(catalog: ModelInfo[] = MODEL_CATALOG) {
    this.catalog = new Map(catalog.map(model => [model.id, model]));
    
    // Build tier index
    this.tierIndex = new Map();
    for (const tier of ['premium', 'standard', 'fast'] as ModelTier[]) {
      this.tierIndex.set(
        tier,
        catalog.filter(m => m.tier === tier)
      );
    }
    
    // Build provider index
    this.providerIndex = new Map();
    for (const model of catalog) {
      const existing = this.providerIndex.get(model.provider) || [];
      existing.push(model);
      this.providerIndex.set(model.provider, existing);
    }
  }
  
  /**
   * Gets model information by ID.
   * 
   * @param id - Model identifier
   * @returns Model info if found, null otherwise
   */
  getModelInfo(id: ModelId): ModelInfo | null {
    return this.catalog.get(id) || null;
  }
  
  /**
   * Checks if a model is available in the catalog.
   * 
   * @param id - Model identifier
   * @returns True if model exists in catalog
   */
  isModelAvailable(id: ModelId): boolean {
    return this.catalog.has(id);
  }
  
  /**
   * Gets all models for a specific tier.
   * 
   * @param tier - Model tier
   * @returns Array of models in that tier
   */
  getModelsByTier(tier: ModelTier): ModelInfo[] {
    return this.tierIndex.get(tier) || [];
  }
  
  /**
   * Gets all models from a specific provider.
   * 
   * @param provider - Provider name
   * @returns Array of models from that provider
   */
  getModelsByProvider(provider: string): ModelInfo[] {
    return this.providerIndex.get(provider) || [];
  }
  
  /**
   * Gets the fallback chain for a specific tier.
   * 
   * @param tier - Model tier
   * @param preferSameProvider - If true, prefer models from same provider
   * @param currentModel - Current model (for provider preference)
   * @returns Ordered array of fallback model IDs
   */
  getFallbackChain(
    tier: ModelTier,
    preferSameProvider: boolean = true,
    currentModel?: ModelId
  ): ModelId[] {
    const defaultChain = DEFAULT_FALLBACK_CHAINS[tier] || [];
    
    if (!preferSameProvider || !currentModel) {
      return defaultChain;
    }
    
    // Get current model's provider
    const current = this.getModelInfo(currentModel);
    if (!current) {
      return defaultChain;
    }
    
    // Reorder chain to prefer same provider
    const sameProvider = defaultChain.filter(id => {
      const model = this.getModelInfo(id);
      return model?.provider === current.provider;
    });
    
    const otherProvider = defaultChain.filter(id => {
      const model = this.getModelInfo(id);
      return model?.provider !== current.provider;
    });
    
    return [...sameProvider, ...otherProvider];
  }
  
  /**
   * Gets the next fallback model in the chain.
   * 
   * @param currentModel - Current model that failed
   * @param tier - Model tier
   * @param attemptedModels - Models already attempted
   * @returns Next fallback model ID, or null if chain exhausted
   */
  getNextFallback(
    currentModel: ModelId,
    tier: ModelTier,
    attemptedModels: Set<ModelId> = new Set()
  ): ModelId | null {
    const chain = this.getFallbackChain(tier, true, currentModel);
    
    // Find next model in chain that hasn't been attempted
    for (const modelId of chain) {
      if (modelId !== currentModel && !attemptedModels.has(modelId)) {
        return modelId;
      }
    }
    
    return null;
  }
  
  /**
   * Gets model recommendations based on use case.
   * 
   * @param useCase - Desired use case
   * @param tier - Optional tier constraint
   * @returns Recommended models sorted by relevance
   */
  getRecommendedModels(useCase: string, tier?: ModelTier): ModelInfo[] {
    const useCaseLower = useCase.toLowerCase();
    const candidates = tier
      ? this.getModelsByTier(tier)
      : Array.from(this.catalog.values());
    
    // Score models by use case match
    const scored = candidates
      .map(model => ({
        model,
        score: model.useCases?.some(uc => 
          uc.toLowerCase().includes(useCaseLower) ||
          useCaseLower.includes(uc.toLowerCase())
        ) ? 10 : 0
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    
    return scored.map(item => item.model);
  }
  
  /**
   * Gets all model IDs in the catalog.
   * 
   * @returns Array of all model IDs
   */
  getAllModelIds(): ModelId[] {
    return Array.from(this.catalog.keys());
  }
  
  /**
   * Gets catalog statistics.
   * 
   * @returns Catalog stats
   */
  getStats(): {
    total: number;
    byTier: Record<ModelTier, number>;
    byProvider: Record<string, number>;
  } {
    const byTier: Record<ModelTier, number> = {
      premium: 0,
      standard: 0,
      fast: 0
    };
    
    const byProvider: Record<string, number> = {};
    
    for (const model of this.catalog.values()) {
      byTier[model.tier]++;
      byProvider[model.provider] = (byProvider[model.provider] || 0) + 1;
    }
    
    return {
      total: this.catalog.size,
      byTier,
      byProvider
    };
  }
}

/**
 * Default model registry instance.
 */
export const defaultRegistry = new ModelRegistry();

/**
 * Gets model information by ID (convenience function).
 */
export function getModelInfo(id: ModelId): ModelInfo | null {
  return defaultRegistry.getModelInfo(id);
}

/**
 * Gets fallback chain for a tier (convenience function).
 */
export function getFallbackChain(tier: ModelTier): ModelId[] {
  return defaultRegistry.getFallbackChain(tier);
}

/**
 * Checks if model is available (convenience function).
 */
export function isModelAvailable(id: ModelId): boolean {
  return defaultRegistry.isModelAvailable(id);
}

/**
 * Estimate the cost of a model invocation based on token counts and
 * the SDK's built-in pricing table.
 *
 * @returns Estimated cost in USD, or 0 if pricing is unavailable for the model.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const info = defaultRegistry.getModelInfo(model as ModelId);
  if (!info?.pricing) return 0;
  return (inputTokens * info.pricing.inputPerToken) + (outputTokens * info.pricing.outputPerToken);
}

// ============================================================================
// Persistent Model Preference (Layer 0)
// ============================================================================

/**
 * Economy mode model map: normal model → cheaper alternative.
 *
 * Applied at Layer 3 (task-aware auto) and Layer 4 (default) when
 * economy mode is active. Layers 0–2 (explicit preferences) are
 * never substituted — the user's explicit choice always wins.
 *
 * Table source: issue #500
 */
export const ECONOMY_MODEL_MAP: Record<string, string> = {
  // Premium → flash downgrade
  'gemini-pro-latest': 'gemini-flash-latest',

  // Anthropic: one step down the tier ladder, never across providers.
  // Haiku is already the cheapest Claude model, so it maps to itself by
  // omission rather than being listed.
  'claude-opus-5': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-haiku-4-5',
};

/**
 * Applies economy mode substitution to a model ID.
 * Returns the cheaper economy alternative, or the original if no mapping exists.
 */
export function applyEconomyMode(model: string): string {
  return ECONOMY_MODEL_MAP[model] ?? model;
}

/**
 * Shape of model preference fields within `.squad/config.json`.
 */
export interface ModelPreferenceConfig {
  defaultModel?: string;
  agentModelOverrides?: Record<string, string>;
  economyMode?: boolean;
  defaultReasoningEffort?: string;
  agentReasoningEffortOverrides?: Record<string, string>;
  /** Which backend sessions run on. See `adapter/backend-factory.ts`. */
  provider?: string;
}

/** Narrow an arbitrary string to a known provider, or null. */
export function asProvider(value: unknown): SquadProvider | null {
  // Derived from the vendor registry, so a newly registered vendor is
  // accepted here without a second list to remember to update.
  return typeof value === 'string' && (KNOWN_PROVIDERS as string[]).includes(value)
    ? (value as SquadProvider)
    : null;
}

/**
 * Reads the persistent provider preference from `.squad/config.json`.
 *
 * Returns null when unset or unrecognized — an unknown provider name falls
 * through to the next resolution layer rather than failing the session, since
 * the likeliest cause is a config written by a newer squad.
 */
export function readProviderPreference(
  squadDir: string,
  storage: StorageProvider = new FSStorageProvider(),
): 'anthropic' | 'gemini' | null {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) return null;
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return asProvider(parsed.provider);
  } catch {
    return null;
  }
}

/**
 * Writes the provider preference to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 */
export function writeProviderPreference(
  squadDir: string,
  provider: 'anthropic' | 'gemini' | null,
  storage: StorageProvider = new FSStorageProvider(),
): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      if (raw !== undefined) {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') config = parsed;
      }
    } catch {
      // Unreadable config is replaced rather than blocking the write.
    }
  }

  if (provider === null) delete config['provider'];
  else config['provider'] = provider;

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Reads the economy mode setting from `.squad/config.json`.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @returns True if economyMode is enabled, false otherwise
 */
export function readEconomyMode(squadDir: string, storage: StorageProvider = new FSStorageProvider()): boolean {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) {
    return false;
  }
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return false;
    const parsed = JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === 'object' &&
      parsed.economyMode === true;
  } catch {
    return false;
  }
}

/**
 * Writes the economy mode setting to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @param enabled - Whether economy mode should be enabled
 */
export function writeEconomyMode(squadDir: string, enabled: boolean, storage: StorageProvider = new FSStorageProvider()): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      config = raw !== undefined ? JSON.parse(raw) : { version: 1 };
    } catch {
      config = { version: 1 };
    }
  } else {
    config = { version: 1 };
  }

  if (enabled) {
    config.economyMode = true;
  } else {
    delete config.economyMode;
  }

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Reads the persistent model preference from `.squad/config.json`.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @returns The defaultModel string if set, or null
 */
export function readModelPreference(squadDir: string, storage: StorageProvider = new FSStorageProvider()): string | null {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.defaultModel === 'string' &&
      parsed.defaultModel.length > 0
    ) {
      return parsed.defaultModel;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads per-agent model overrides from `.squad/config.json`.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @returns Record of agent name → model ID, or empty object
 */
export function readAgentModelOverrides(squadDir: string, storage: StorageProvider = new FSStorageProvider()): Record<string, string> {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) {
    return {};
  }
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return {};
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.agentModelOverrides === 'object' &&
      parsed.agentModelOverrides !== null
    ) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.agentModelOverrides)) {
        if (typeof value === 'string') {
          result[key] = value;
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Writes a persistent model preference to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @param model - Model ID to persist, or null to clear
 */
export function writeModelPreference(squadDir: string, model: string | null, storage: StorageProvider = new FSStorageProvider()): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      config = raw !== undefined ? JSON.parse(raw) : { version: 1 };
    } catch {
      config = { version: 1 };
    }
  } else {
    config = { version: 1 };
  }

  if (model === null) {
    delete config.defaultModel;
  } else {
    config.defaultModel = model;
  }

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Writes per-agent model overrides to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @param overrides - Record of agent name → model ID, or null to clear
 */
export function writeAgentModelOverrides(
  squadDir: string,
  overrides: Record<string, string> | null,
  storage: StorageProvider = new FSStorageProvider()
): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      config = raw !== undefined ? JSON.parse(raw) : { version: 1 };
    } catch {
      config = { version: 1 };
    }
  } else {
    config = { version: 1 };
  }

  if (overrides === null || Object.keys(overrides).length === 0) {
    delete config.agentModelOverrides;
  } else {
    config.agentModelOverrides = overrides;
  }

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Valid reasoning effort levels, ordered from lowest to highest.
 * "auto" is a permitted stored sentinel that resolvers treat as "not set".
 * Canonical runtime list — import this instead of duplicating. The `satisfies`
 * clause keeps it in lock-step with the canonical {@link SquadReasoningEffort} type.
 */
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly SquadReasoningEffort[];
/** Canonical reasoning-effort union (alias of {@link SquadReasoningEffort}). */
export type ValidReasoningEffort = SquadReasoningEffort;
const VALID_REASONING_EFFORTS_WITH_AUTO: readonly string[] = [...VALID_REASONING_EFFORTS, 'auto'];
/** String array form for runtime `.includes()` checks with arbitrary strings. */
const VALID_EFFORTS_SET: readonly string[] = VALID_REASONING_EFFORTS;

/**
 * Ordered effort levels for clamping. "max" is treated as equivalent to "xhigh".
 */
const EFFORT_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 3,
};

/**
 * Clamp a requested reasoning effort to the highest level supported by the model.
 *
 * If the model does not support reasoning effort at all (empty or missing
 * supportedEfforts), returns undefined. If the requested effort is within
 * the model's supported range, returns it unchanged. Otherwise, returns the
 * highest effort the model supports.
 *
 * Deliberate: when the requested effort is *below* the model's minimum
 * supported level (e.g. "low" against a model that only supports ["high"]),
 * it is clamped UP to that minimum so a reasoning-capable model always
 * receives a valid level rather than undefined. This upward clamp is
 * intentional — see the clampReasoningEffort tests in model-preference.test.ts.
 *
 * @param requested - The reasoning effort the user/charter requested
 * @param supportedEfforts - The model's supportedReasoningEfforts from listModels()
 * @returns The clamped effort, or undefined if the model doesn't support reasoning effort
 */
export function clampReasoningEffort(
  requested: string | undefined,
  supportedEfforts: string[] | undefined,
): string | undefined {
  if (!requested) return undefined;

  // Model doesn't support reasoning effort at all
  if (!supportedEfforts || supportedEfforts.length === 0) return undefined;

  const requestedRank = EFFORT_RANK[requested];
  if (requestedRank === undefined) return undefined;

  // Check if the requested effort is directly supported
  if (supportedEfforts.includes(requested)) return requested;
  // "max" and "xhigh" are equivalent
  if (requested === 'xhigh' && supportedEfforts.includes('max')) return 'xhigh';
  if (requested === 'max' && supportedEfforts.includes('xhigh')) return 'xhigh';

  // Find the highest supported effort that doesn't exceed the request
  let bestEffort: string | undefined;
  let bestRank = -1;
  for (const effort of supportedEfforts) {
    const rank = EFFORT_RANK[effort];
    if (rank !== undefined && rank <= requestedRank && rank > bestRank) {
      bestRank = rank;
      bestEffort = effort;
    }
  }

  // Deliberate: if nothing is <= requested, the request is below the model's
  // minimum supported level — clamp UP to the model's lowest so a
  // reasoning-capable model never receives undefined here.
  if (!bestEffort) {
    let lowestRank = Infinity;
    for (const effort of supportedEfforts) {
      const rank = EFFORT_RANK[effort];
      if (rank !== undefined && rank < lowestRank) {
        lowestRank = rank;
        bestEffort = effort;
      }
    }
  }

  return bestEffort;
}

/**
 * Reads the persistent reasoning effort preference from `.squad/config.json`.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @returns The defaultReasoningEffort string if set, or null
 */
export function readReasoningEffort(squadDir: string, storage: StorageProvider = new FSStorageProvider()): string | null {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof parsed.defaultReasoningEffort === 'string' &&
      parsed.defaultReasoningEffort.length > 0 &&
      VALID_REASONING_EFFORTS_WITH_AUTO.includes(parsed.defaultReasoningEffort)
    ) {
      return parsed.defaultReasoningEffort;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads per-agent reasoning effort overrides from `.squad/config.json`.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @returns Record of agent name → reasoning effort, or empty object
 */
export function readAgentReasoningEffortOverrides(squadDir: string, storage: StorageProvider = new FSStorageProvider()): Record<string, string> {
  const configPath = join(squadDir, 'config.json');
  if (!storage.existsSync(configPath)) {
    return {};
  }
  try {
    const raw = storage.readSync(configPath);
    if (raw === undefined) return {};
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.agentReasoningEffortOverrides === 'object' &&
      parsed.agentReasoningEffortOverrides !== null
    ) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.agentReasoningEffortOverrides)) {
        if (typeof value === 'string' && VALID_EFFORTS_SET.includes(value)) {
          result[key] = value;
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Writes a persistent reasoning effort preference to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @param effort - Reasoning effort to persist, or null to clear
 */
export function writeReasoningEffort(squadDir: string, effort: string | null, storage: StorageProvider = new FSStorageProvider()): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      const parsed = raw !== undefined ? JSON.parse(raw) : null;
      config = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed as Record<string, unknown>
        : { version: 1 };
    } catch {
      config = { version: 1 };
    }
  } else {
    config = { version: 1 };
  }

  if (effort === null) {
    delete config.defaultReasoningEffort;
  } else if (VALID_REASONING_EFFORTS_WITH_AUTO.includes(effort)) {
    config.defaultReasoningEffort = effort;
  } else {
    // Invalid value: warn and leave any existing preference untouched rather
    // than silently clearing it (a typo shouldn't wipe a valid setting).
    // Pass null explicitly to clear.
    console.warn(
      `[squad] writeReasoningEffort: ignoring invalid reasoning effort "${effort}" `
      + `(expected ${VALID_REASONING_EFFORTS.join(', ')}, auto, or null to clear); `
      + `existing preference left unchanged.`,
    );
    return;
  }

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Writes per-agent reasoning effort overrides to `.squad/config.json`.
 * Merges with existing config — does not overwrite other fields.
 *
 * @param squadDir - Path to the `.squad/` directory
 * @param overrides - Record of agent name → reasoning effort, or null to clear
 */
export function writeAgentReasoningEffortOverrides(
  squadDir: string,
  overrides: Record<string, string> | null,
  storage: StorageProvider = new FSStorageProvider()
): void {
  const configPath = join(squadDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (storage.existsSync(configPath)) {
    try {
      const raw = storage.readSync(configPath);
      const parsed = raw !== undefined ? JSON.parse(raw) : null;
      config = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed as Record<string, unknown>
        : { version: 1 };
    } catch {
      config = { version: 1 };
    }
  } else {
    config = { version: 1 };
  }

  if (overrides === null || Object.keys(overrides).length === 0) {
    delete config.agentReasoningEffortOverrides;
  } else {
    // Filter out invalid effort values, warning about any dropped so a typo
    // isn't silently discarded.
    const validated: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [agent, effort] of Object.entries(overrides)) {
      if (VALID_REASONING_EFFORTS_WITH_AUTO.includes(effort)) {
        validated[agent] = effort;
      } else {
        dropped.push(`${agent}="${effort}"`);
      }
    }
    if (dropped.length > 0) {
      console.warn(
        `[squad] writeAgentReasoningEffortOverrides: ignoring invalid reasoning effort `
        + `value(s) ${dropped.join(', ')} (expected ${VALID_REASONING_EFFORTS.join(', ')}, or auto).`,
      );
    }
    if (Object.keys(validated).length > 0) {
      config.agentReasoningEffortOverrides = validated;
    } else {
      delete config.agentReasoningEffortOverrides;
    }
  }

  storage.writeSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Resolves the effective reasoning effort for an agent spawn.
 * Uses a layered priority system matching the model resolution pattern:
 *   Layer 0a: Per-agent persistent override (.squad/config.json agentReasoningEffortOverrides)
 *   Layer 0b: Global persistent config (.squad/config.json defaultReasoningEffort)
 *   Layer 1: Spawn-time override (caller-provided)
 *   Layer 2: Charter preference (agent's ## Model → **Reasoning Effort:** field)
 *   Layer 3: Default (undefined — let SDK/API decide)
 *
 * The value "auto" at any layer is treated as "not set" and falls through.
 *
 * When `supportedEfforts` is provided (from the model's capabilities via
 * listModels()), the resolved effort is clamped to the highest level the
 * model supports. This prevents API errors when a user requests e.g.
 * "xhigh" on a model that only supports up to "high".
 *
 * @param options - Resolution inputs
 * @returns Resolved reasoning effort string, or undefined if unset
 */
export function resolveReasoningEffort(options: {
  agentName?: string;
  squadDir?: string;
  spawnOverride?: string | null;
  charterPreference?: string | null;
  /** Model's supportedReasoningEfforts from listModels(). When provided, clamps the result. */
  supportedEfforts?: string[];
  storage?: StorageProvider;
}): string | undefined {
  const { agentName, squadDir, spawnOverride, charterPreference } = options;
  const storage = options.storage ?? new FSStorageProvider();

  let resolved: string | undefined;

  // Helper: only accept valid effort values (reject invalid strings)
  const isValid = (v: string | null | undefined): v is string =>
    typeof v === 'string' && v !== 'auto' && VALID_EFFORTS_SET.includes(v);

  // Layer 0a: Per-agent persistent override
  if (!resolved && squadDir && agentName) {
    const agentOverrides = readAgentReasoningEffortOverrides(squadDir, storage);
    const agentEffort = agentOverrides[agentName];
    if (isValid(agentEffort)) {
      resolved = agentEffort;
    }
  }

  // Layer 0b: Global persistent config
  if (!resolved && squadDir) {
    const persistedEffort = readReasoningEffort(squadDir, storage);
    if (isValid(persistedEffort)) {
      resolved = persistedEffort;
    }
  }

  // Layer 1: Spawn-time override
  if (!resolved && isValid(spawnOverride)) {
    resolved = spawnOverride;
  }

  // Layer 2: Charter preference
  if (!resolved && isValid(charterPreference)) {
    resolved = charterPreference;
  }

  // Layer 3: Default — undefined (let SDK/API decide)
  if (!resolved) return undefined;

  // Clamp to model capabilities if available
  if (options.supportedEfforts) {
    return clampReasoningEffort(resolved, options.supportedEfforts);
  }

  return resolved;
}

/**
 * Resolves the effective model for an agent spawn using the 5-layer hierarchy:
 *   Layer 0: Persistent config (.squad/config.json defaultModel)
 *   Layer 1: Session-wide user directive ("always use gemini-pro")
 *   Layer 2: Charter preference (agent's ## Model section)
 *   Layer 3: Task-aware auto-selection (code → flash/sonnet, docs → flash/sonnet)
 *   Layer 4: Default (the `provider`'s standard-tier model)
 *
 * Per-agent overrides from config.json take priority over the global defaultModel.
 *
 * Economy mode modifier: when active (via economyMode option or config.json),
 * shifts model selection at Layer 3 and Layer 4 to cheaper alternatives per
 * ECONOMY_MODEL_MAP. Layers 0–2 (explicit user preferences) are never overridden.
 *
 * @param options - Resolution inputs
 * @returns Resolved model ID
 */
export function resolveModel(options: {
  agentName?: string;
  squadDir?: string;
  sessionDirective?: string | null;
  charterPreference?: string | null;
  taskModel?: string | null;
  /** When true, apply economy mode substitution at Layer 3/4. Overrides config. */
  economyMode?: boolean;
  /** Storage provider for config file access. */
  storage?: StorageProvider;
  /**
   * Backend the resolved model must belong to. Only affects Layer 4 — every
   * earlier layer is an explicit choice the caller already made, and silently
   * rewriting those to match the provider would hide a real misconfiguration
   * behind a model that happens to load.
   * @default 'gemini' (preserves pre-existing behaviour for callers that
   *          haven't been made provider-aware yet)
   */
  provider?: 'anthropic' | 'gemini';
}): string {
  const { agentName, squadDir, sessionDirective, charterPreference, taskModel } = options;
  const storage = options.storage ?? new FSStorageProvider();

  // Layer 0a: Per-agent persistent override (explicit — economy does not apply)
  if (squadDir && agentName) {
    const agentOverrides = readAgentModelOverrides(squadDir, storage);
    if (agentOverrides[agentName]) {
      return agentOverrides[agentName]!;
    }
  }

  // Layer 0b: Global persistent config (explicit — economy does not apply)
  if (squadDir) {
    const persistedModel = readModelPreference(squadDir, storage);
    if (persistedModel) {
      return persistedModel;
    }
  }

  // Layer 1: Session-wide user directive (explicit — economy does not apply)
  if (sessionDirective) {
    return sessionDirective;
  }

  // Layer 2: Charter preference (explicit — economy does not apply)
  if (charterPreference) {
    return charterPreference;
  }

  // Determine if economy mode is active (option takes precedence over config)
  const isEconomy =
    options.economyMode !== undefined
      ? options.economyMode
      : (squadDir ? readEconomyMode(squadDir, storage) : false);

  // Layer 3: Task-aware auto-selection (economy mode applies)
  if (taskModel) {
    return isEconomy ? applyEconomyMode(taskModel) : taskModel;
  }

  // Layer 4: Default (economy mode applies). Provider-aware — the standard
  // tier of whichever backend the session will actually run on.
  const defaultModel = FALLBACK_CHAINS_BY_PROVIDER[options.provider ?? 'gemini'].standard[0]!;
  return isEconomy ? applyEconomyMode(defaultModel) : defaultModel;
}
