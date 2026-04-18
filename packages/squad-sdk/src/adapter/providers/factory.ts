/**
 * Provider Factory
 *
 * Creates the appropriate ISquadClientBackend based on the provider type
 * specified in SquadClientOptions. This is the single decision point for
 * provider selection — everything else in SquadClient is provider-agnostic.
 *
 * @module adapter/providers/factory
 */

import type { ISquadClientBackend, SquadProviderType } from './base.js';
import { CopilotBackend } from './copilot.js';
import { AnthropicBackend } from './anthropic.js';
import { GeminiBackend } from './gemini.js';
import type { SquadClientOptions } from '../client.js';

/**
 * Instantiate the correct backend for the requested provider.
 *
 * @param provider - One of 'copilot' | 'anthropic' | 'gemini'. Defaults to 'copilot'.
 * @param options  - Full SquadClientOptions passed through to the backend constructor.
 * @returns        An ISquadClientBackend ready to be connect()ed.
 *
 * @example
 * ```typescript
 * const backend = createBackend('anthropic', { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } });
 * await backend.connect();
 * const session = await backend.createSession({ model: 'claude-sonnet-4-5' });
 * ```
 */
export function createBackend(
  provider: SquadProviderType | undefined,
  options: SquadClientOptions
): ISquadClientBackend {
  switch (provider) {
    case 'anthropic':
      return new AnthropicBackend(options);
    case 'gemini':
      return new GeminiBackend(options);
    case 'copilot':
    default:
      return new CopilotBackend(options);
  }
}

export type { SquadProviderType };
