/**
 * Backend seam — the contract every model provider implements.
 *
 * `SquadClient` is a lifecycle wrapper and tracing shim; the provider-specific
 * work lives behind this interface. Before this existed, `SquadClient` held a
 * concrete `GeminiClient` and hardcoded four Gemini-shaped answers
 * (`listSessions`, `getStatus`, `listModels`, `on`) directly in the wrapper,
 * which meant a second provider could not be added without editing them.
 *
 * The five required members are exactly what `SquadClient` cannot work
 * without. The optional ones have sensible wrapper-side fallbacks, so a
 * backend only implements them when it has something better than the default
 * to say — that is what keeps "Gemini is stateless" a *Gemini* fact rather
 * than a squad-wide one.
 *
 * @module adapter/backend
 */

import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionMetadata,
  SquadGetAuthStatusResponse,
  SquadGetStatusResponse,
  SquadModelInfo,
  SquadClientEvent,
  SquadClientEventType,
} from './types.js';

/** Model providers squad can talk to. */
export type SquadProvider = 'anthropic' | 'gemini';

/** Every provider squad supports implements this. */
export interface SquadBackend {
  /** Establish and validate credentials. Throws with an actionable message on failure. */
  start(): Promise<void>;

  /** Release resources. Returns any errors encountered rather than throwing. */
  stop(): Promise<Error[]>;

  isStarted(): boolean;

  /** Create a session. Synchronous — `SquadSession.sessionId` is read immediately by callers. */
  createSession(config: SquadSessionConfig): SquadSession;

  getAuthStatus(): Promise<SquadGetAuthStatusResponse>;

  // --- Optional. Omit unless the backend can do better than the fallback. ---

  /** Server-side session listing. Omit when the provider is stateless (fallback: `[]`). */
  listSessions?(): Promise<SquadSessionMetadata[]>;

  /** Fallback: `{ version: <provider>, protocolVersion: 1 }`. */
  getStatus?(): Promise<SquadGetStatusResponse>;

  /** Live model listing. Omit when the local catalog is authoritative (fallback: `[]`). */
  listModels?(): Promise<SquadModelInfo[]>;

  /** Fallback: `undefined`. */
  getLastSessionId?(): Promise<string | undefined>;

  /**
   * Client-level lifecycle events (session created/deleted/...).
   * Omit when the provider has no server-push channel (fallback: a no-op
   * unsubscribe, so callers never have to null-check).
   */
  on?(eventType: SquadClientEventType, handler: (event: SquadClientEvent) => void): () => void;
}
