/**
 * Typed Event Payloads for SquadEventType (Issue #304)
 *
 * Canonical payload types for every EventBus event type.
 * These are the SDK-owned contracts that downstream consumers
 * (e.g., SquadOffice visualization) depend on.
 *
 * @module runtime/event-payloads
 */

import type { SquadEventType, SquadEvent } from './event-bus.js';

// ============================================================================
// Session lifecycle payloads
// ============================================================================

export interface SessionCreatedPayload {
  agentName: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface SessionIdlePayload {
  agentName: string;
  idleSince?: number;
}

export interface SessionErrorPayload {
  agentName: string;
  error: string;
}

export interface SessionDestroyedPayload {
  agentName: string;
  reason?: 'complete' | 'error' | 'abort' | 'timeout' | 'user_exit';
}

// ============================================================================
// Session operational payloads
// ============================================================================

export interface SessionMessagePayload {
  message: string;
  role?: string;
  content?: string;
}

export interface SessionToolCallPayload {
  toolName: string;
  toolArgs: Record<string, unknown>;
  resultType?: 'success' | 'failure' | 'rejected' | 'denied';
  /** Wall-clock from the call being raised to its result arriving. */
  durationMs?: number;
}

/**
 * What one model invocation actually consumed.
 *
 * The backend's own numbers where it reports them — a provider that says what a
 * turn cost accounts for cache reads and writes and names the model that truly
 * served the turn, which a catalog estimate cannot. `estimatedCost` is USD;
 * consumers that need integer money (ADP records micro-USD) convert at the edge
 * rather than this payload pretending to a precision it does not have.
 */
export interface SessionModelUsagePayload {
  model: string;
  /**
   * Every input token the turn processed, cached and uncached.
   *
   * Backends that cache report the cached portion separately; a consumer that
   * reads only the uncached remainder under-counts by orders of magnitude.
   */
  inputTokens: number;
  outputTokens: number;
  /** Cached-input breakdown, where the backend reports one. Priced differently. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Every model that billed for this turn, when more than one did. */
  models?: {
    model: string;
    uncachedInputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }[];
  /** Model round-trips behind this turn, where the backend reports it. */
  numTurns?: number;
  /** Time to first token, in milliseconds. */
  ttftMs?: number;
  /** USD. Reported by the backend when it can, estimated from the catalog otherwise. */
  estimatedCost?: number;
  durationMs?: number;
  /** True when this turn ran on a fallback model after another one failed. */
  isFallback?: boolean;
  agentName?: string;
}

// ============================================================================
// Coordination payloads
// ============================================================================

/** Multi-phase coordinator routing - discriminated by `phase`. */
export type CoordinatorRoutingPayload =
  | { phase: 'start'; messageLength: number }
  | { phase: 'routed'; agents: string[]; confidence: 'high' | 'medium' | 'low'; reason: string }
  | { phase: 'spawning'; strategy: 'direct' | 'single' | 'multi' | 'fallback'; agentCount: number }
  | { phase: 'complete'; strategy: string; spawnCount: number; successCount: number };

// ============================================================================
// Agent milestone payloads - discriminated by `event`
// ============================================================================

export type AgentMilestonePayload =
  | {
      event: 'model.fallback';
      agentName: string;
      failedModel: string;
      failedTier: 'premium' | 'standard' | 'fast';
      error: string;
      attemptNumber: number;
    }
  | {
      event: 'model.exhausted';
      agentName: string;
      originalModel: string;
      originalTier: string;
      totalAttempts: number;
    };

// ============================================================================
// Pool health payload
// ============================================================================

export interface PoolHealthPayload {
  activeSessions: number;
  availableSlots: number;
  queuedRequests: number;
}

// ============================================================================
// Payload map - maps each event type to its payload shape
// ============================================================================

export interface SquadEventPayloadMap {
  'session:created': SessionCreatedPayload;
  'session:idle': SessionIdlePayload;
  'session:error': SessionErrorPayload;
  'session:destroyed': SessionDestroyedPayload;
  'session:message': SessionMessagePayload;
  'session:model_usage': SessionModelUsagePayload;
  'session:tool_call': SessionToolCallPayload;
  'agent:milestone': AgentMilestonePayload;
  'coordinator:routing': CoordinatorRoutingPayload;
  'pool:health': PoolHealthPayload;
}

// ============================================================================
// Typed event - narrows payload based on event type
// ============================================================================

/**
 * A strongly-typed SquadEvent where the payload type is inferred from the
 * event type discriminant. Use this for type-safe event construction.
 */
export interface TypedSquadEvent<T extends SquadEventType = SquadEventType> {
  type: T;
  sessionId?: string;
  agentName?: string;
  payload: T extends keyof SquadEventPayloadMap ? SquadEventPayloadMap[T] : unknown;
  timestamp: Date;
}

/**
 * Type guard: narrows a SquadEvent to a specific typed event.
 */
export function isSquadEventOfType<T extends SquadEventType>(
  event: SquadEvent,
  type: T,
): event is TypedSquadEvent<T> {
  return event.type === type;
}

/**
 * Helper to construct a typed SquadEvent with payload validation at compile time.
 */
export function createSquadEvent<T extends SquadEventType>(
  type: T,
  payload: T extends keyof SquadEventPayloadMap ? SquadEventPayloadMap[T] : unknown,
  options?: { sessionId?: string; agentName?: string },
): TypedSquadEvent<T> {
  return {
    type,
    sessionId: options?.sessionId,
    agentName: options?.agentName,
    payload,
    timestamp: new Date(),
  };
}