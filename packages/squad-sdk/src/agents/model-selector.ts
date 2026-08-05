/**
 * Per-Agent Model Selection (M1-9) + Model Fallback (M3-5, Issue #145)
 */

import { MODELS } from '../runtime/constants.js';
import { applyEconomyMode, getModelInfo, FALLBACK_CHAINS_BY_PROVIDER } from '../config/models.js';
import { defaultVendor, providerForModel } from '../config/vendors.js';
import type { EventBus } from '../runtime/event-bus.js';

/**
 * Task types that influence model selection.
 */
export type TaskType = 'code' | 'prompt' | 'docs' | 'visual' | 'planning' | 'mechanical';

/**
 * Model tier classification.
 */
export type ModelTier = 'premium' | 'standard' | 'fast';

/**
 * Source of the model resolution.
 */
export type ModelResolutionSource = 'user-override' | 'charter' | 'task-auto' | 'default';

/**
 * Options for model resolution.
 */
export interface ModelResolutionOptions {
  /** User-specified model override */
  userOverride?: string;
  /** Model preference from agent's charter (## Model section) */
  charterPreference?: string;
  /** Type of task being performed */
  taskType: TaskType;
  /** Agent role (for context) */
  agentRole?: string;
  /** When true, apply economy mode substitution at Layer 3/4 */
  economyMode?: boolean;
}

/**
 * Result of model resolution.
 */
export interface ResolvedModel {
  /** Selected model identifier */
  model: string;
  /** Model tier classification */
  tier: ModelTier;
  /** Source that determined the model */
  source: ModelResolutionSource;
  /** Fallback chain for this tier */
  fallbackChain: string[];
}

/**
 * Resolve the appropriate model using the 4-layer priority system.
 * 
 * @param options - Model resolution options
 * @returns Resolved model with tier and fallback chain
 */
/**
 * The fallback chain a given model may actually walk.
 *
 * Keyed by the model's own vendor, not by the default one: a session is bound
 * to a single backend, so handing a Gemini model a chain of Claude models
 * offers a retry that cannot run — and, worse, one that would be recorded
 * against the wrong vendor in a comparison. Models outside the registry fall
 * back to the default vendor's chain.
 */
function chainForModel(model: string, tier: ModelTier): string[] {
  const provider = providerForModel(model as Parameters<typeof providerForModel>[0]);
  const chains = provider ? FALLBACK_CHAINS_BY_PROVIDER[provider] : undefined;
  return [...((chains ?? MODELS.FALLBACK_CHAINS)[tier] ?? [])];
}

export function resolveModel(options: ModelResolutionOptions): ResolvedModel {
  const { userOverride, charterPreference, taskType, economyMode } = options;

  // Layer 1: User Override (explicit — economy does not apply)
  if (userOverride && userOverride.trim().length > 0) {
    const tier = inferTierFromModel(userOverride);
    return {
      model: userOverride,
      tier,
      source: 'user-override',
      fallbackChain: chainForModel(userOverride, tier),
    };
  }

  // Layer 2: Charter Preference (explicit — economy does not apply)
  if (charterPreference && charterPreference.trim().length > 0 && charterPreference !== 'auto') {
    const tier = inferTierFromModel(charterPreference);
    return {
      model: charterPreference,
      tier,
      source: 'charter',
      fallbackChain: chainForModel(charterPreference, tier),
    };
  }

  // Layer 3: Task-Aware Auto-Selection (economy mode applies)
  const autoSelected = selectModelForTask(taskType, economyMode);
  if (autoSelected) {
    return autoSelected;
  }

  // Layer 4: Default (economy mode applies)
  const defaultModel = economyMode
    ? applyEconomyMode(MODELS.SELECTOR_DEFAULT)
    : MODELS.SELECTOR_DEFAULT;
  const defaultTier = inferTierFromModel(defaultModel);
  return {
    model: defaultModel,
    tier: defaultTier,
    source: 'default',
    fallbackChain: chainForModel(defaultModel, defaultTier),
  };
}

/**
 * Select model based on task type, with optional economy mode substitution.
 * 
 * @param taskType - Type of task being performed
 * @param economyMode - When true, downgrade model to cheaper alternative
 * @returns Resolved model or undefined if no match
 */
function selectModelForTask(taskType: TaskType, economyMode?: boolean): ResolvedModel | undefined {
  let tier: ModelTier | undefined;

  // Task type picks a *tier*; the vendor registry picks the model for it.
  // These arms used to name Gemini model ids outright, which survived the move
  // to the registry and left task-auto selection handing back a Gemini model
  // with the default vendor's (Claude) fallback chain attached — a resolution
  // that was internally inconsistent whichever vendor you were actually on.
  switch (taskType) {
    case 'code':
    case 'prompt':
      tier = 'standard';
      break;
    case 'visual':
      tier = 'premium';
      break;
    case 'docs':
    case 'planning':
    case 'mechanical':
      tier = 'fast';
      break;
    default:
      return undefined;
  }

  let model: string = defaultVendor().models[tier];

  if (economyMode) {
    model = applyEconomyMode(model);
    tier = inferTierFromModel(model);
  }

  return {
    model,
    tier,
    source: 'task-auto',
    fallbackChain: chainForModel(model, tier),
  };
}

export function inferTierFromModel(model: string): ModelTier {
  // Prefer catalog lookup for accuracy
  const info = getModelInfo(model as Parameters<typeof getModelInfo>[0]);
  if (info) return info.tier;

  // Heuristic fallback for unknown / pass-through model IDs
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes('opus') || (lowerModel.includes('pro') && !lowerModel.includes('flash'))) {
    return 'premium';
  }
  if (lowerModel.includes('haiku') || lowerModel.includes('mini') || lowerModel.includes('lite')) {
    return 'fast';
  }
  return 'standard';
}

// ============================================================================
// Model Fallback Executor (M3-5, Issue #145)
// ============================================================================

const TIER_ORDER: Record<ModelTier, number> = { premium: 0, standard: 1, fast: 2 };

export function isTierFallbackAllowed(
  fromTier: ModelTier,
  toTier: ModelTier,
  allowCrossTier: boolean,
): boolean {
  if (allowCrossTier) return true;
  if (fromTier === toTier) return true;
  return TIER_ORDER[toTier] <= TIER_ORDER[fromTier];
}

export interface FallbackAttempt {
  model: string;
  tier: ModelTier;
  error: string;
  timestamp: Date;
}

export interface FallbackResult<T> {
  value: T;
  model: string;
  tier: ModelTier;
  attempts: FallbackAttempt[];
  didFallback: boolean;
}

export interface FallbackExecutorConfig {
  allowCrossTier?: boolean;
  eventBus?: EventBus;
}

export class ModelFallbackExecutor {
  private allowCrossTier: boolean;
  private eventBus?: EventBus;
  private history: Map<string, FallbackAttempt[]> = new Map();

  constructor(config: FallbackExecutorConfig = {}) {
    this.allowCrossTier = config.allowCrossTier ?? false;
    this.eventBus = config.eventBus;
  }

  async execute<T>(
    resolved: ResolvedModel,
    agentName: string,
    fn: (model: string) => Promise<T>,
  ): Promise<FallbackResult<T>> {
    const attempts: FallbackAttempt[] = [];
    const originalTier = resolved.tier;
    const candidates = this.buildCandidateList(resolved);

    for (const candidate of candidates) {
      const candidateTier = inferTierFromModel(candidate);
      if (!isTierFallbackAllowed(originalTier, candidateTier, this.allowCrossTier)) {
        continue;
      }
      try {
        const value = await fn(candidate);
        if (!this.history.has(agentName)) this.history.set(agentName, []);
        this.history.get(agentName)!.push(...attempts);
        return { value, model: candidate, tier: candidateTier, attempts, didFallback: attempts.length > 0 };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const attempt: FallbackAttempt = { model: candidate, tier: candidateTier, error: errorMsg, timestamp: new Date() };
        attempts.push(attempt);
        await this.emitEvent('agent:milestone', { event: 'model.fallback', agentName, failedModel: candidate, failedTier: candidateTier, error: errorMsg, attemptNumber: attempts.length });
      }
    }

    if (!this.history.has(agentName)) this.history.set(agentName, []);
    this.history.get(agentName)!.push(...attempts);
    await this.emitEvent('agent:milestone', { event: 'model.exhausted', agentName, originalModel: resolved.model, originalTier, totalAttempts: attempts.length });
    throw new Error(`All models exhausted for agent '${agentName}'. Tried ${attempts.length} model(s): ${attempts.map(a => a.model).join(', ')}`);
  }

  getHistory(agentName: string): FallbackAttempt[] {
    return this.history.get(agentName) ?? [];
  }

  clearHistory(): void {
    this.history.clear();
  }

  private buildCandidateList(resolved: ResolvedModel): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    const add = (m: string) => { if (!seen.has(m)) { seen.add(m); result.push(m); } };
    add(resolved.model);
    for (const fb of resolved.fallbackChain) add(fb);
    return result;
  }

  private async emitEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.eventBus) return;
    await this.eventBus.emit({ type: type as any, payload, timestamp: new Date() });
  }
}
