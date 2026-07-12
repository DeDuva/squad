/**
 * Backend client contract for Squad SDK.
 *
 * A "backend" owns provider connectivity (API keys, auth checks) and
 * constructs SquadSession instances. SquadClient (client.ts) depends only
 * on this interface, never on a concrete backend class, so backends can be
 * swapped (e.g. AiSdkClient) without touching client lifecycle/OTel code.
 *
 * @module adapter/backend
 */

import type { SquadSession, SquadSessionConfig, SquadGetAuthStatusResponse, SquadModelInfo } from './types.js';

export interface SquadBackendClient {
  /** Validate configuration and mark the backend ready for use. */
  start(): Promise<void>;

  /** Tear down the backend, returning any errors encountered. */
  stop(): Promise<Error[]>;

  /** Whether start() has completed successfully. */
  isStarted(): boolean;

  /** Create a new session for the given config. */
  createSession(config: SquadSessionConfig): SquadSession;

  /** Check current authentication status. */
  getAuthStatus(): Promise<SquadGetAuthStatusResponse>;

  /** List models available from this backend (may be empty if catalog-only). */
  listModels(): Promise<SquadModelInfo[]>;
}
