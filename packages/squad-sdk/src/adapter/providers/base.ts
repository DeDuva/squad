/**
 * Squad Provider Backend Interface
 *
 * Defines the contract that all LLM provider backends must satisfy.
 * SquadClient delegates all LLM-specific operations to an ISquadClientBackend
 * instance, keeping the orchestration layer provider-agnostic.
 *
 * Supported providers:
 *   - copilot   — GitHub Copilot via @github/copilot-sdk
 *   - anthropic — Anthropic Claude via @anthropic-ai/sdk
 *   - gemini    — Google Gemini via @google/genai
 *
 * @module adapter/providers/base
 */

import type {
  SquadSession,
  SquadSessionConfig,
  SquadSessionMetadata,
  SquadGetStatusResponse,
  SquadGetAuthStatusResponse,
  SquadModelInfo,
  SquadClientEventType,
  SquadClientEvent,
  SquadClientEventHandler,
} from '../types.js';

export type SquadProviderType = 'copilot' | 'anthropic' | 'gemini';

/**
 * Backend interface that all LLM provider implementations must implement.
 *
 * Mirrors the public API of SquadClient, minus OTel span wrappers
 * (those remain in SquadClient to keep telemetry centralized).
 */
export interface ISquadClientBackend {
  /**
   * Establish connection to the provider.
   * For REST-based providers (Anthropic, Gemini) this is a no-op.
   */
  connect(): Promise<void>;

  /**
   * Gracefully disconnect and clean up resources.
   * Returns any errors encountered during cleanup.
   */
  disconnect(): Promise<Error[]>;

  /**
   * Force disconnect without graceful cleanup.
   */
  forceDisconnect(): Promise<void>;

  /** Whether the provider is ready to accept sessions. */
  isConnected(): boolean;

  /** Create a new agent session. */
  createSession(config: SquadSessionConfig): Promise<SquadSession>;

  /**
   * Resume a previously created session by ID.
   * Providers that don't support session persistence should throw
   * UnsupportedOperationError with a helpful message.
   */
  resumeSession(sessionId: string, config: SquadSessionConfig): Promise<SquadSession>;

  /**
   * List all active/persisted sessions.
   * Providers that don't support session listing should return [].
   */
  listSessions(): Promise<SquadSessionMetadata[]>;

  /**
   * Delete a session by ID.
   * Providers that don't support session persistence should no-op.
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Get the ID of the most recently updated session.
   * Providers that don't track session order should return undefined.
   */
  getLastSessionId(): Promise<string | undefined>;

  /** Send a connectivity ping. */
  ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }>;

  /** Get provider/runtime status information. */
  getStatus(): Promise<SquadGetStatusResponse>;

  /** Get authentication status. */
  getAuthStatus(): Promise<SquadGetAuthStatusResponse>;

  /** List available models for this provider. */
  listModels(): Promise<SquadModelInfo[]>;

  /** Subscribe to client-level lifecycle events. */
  on<K extends SquadClientEventType>(
    eventType: K,
    handler: (event: SquadClientEvent & { type: K }) => void
  ): () => void;
  on(handler: SquadClientEventHandler): () => void;
  on(
    eventTypeOrHandler: SquadClientEventType | SquadClientEventHandler,
    handler?: (event: SquadClientEvent) => void
  ): () => void;
}

/**
 * Thrown when a provider doesn't support a specific operation.
 * Includes guidance on which providers do support it.
 */
export class UnsupportedOperationError extends Error {
  constructor(operation: string, provider: SquadProviderType, hint?: string) {
    super(
      `Operation '${operation}' is not supported by the '${provider}' provider.` +
      (hint ? ` ${hint}` : ' Use the \'copilot\' provider for full session persistence support.')
    );
    this.name = 'UnsupportedOperationError';
  }
}
