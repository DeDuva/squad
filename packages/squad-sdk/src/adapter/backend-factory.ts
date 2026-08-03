/**
 * Chooses which backend a `SquadClient` runs on.
 *
 * @module adapter/backend-factory
 */

import { readProviderPreference, asProvider } from '../config/models.js';
import type { SquadBackend, SquadProvider } from './backend.js';
import { GeminiClient } from './gemini-client.js';

/** Everything the factory needs to pick and construct a backend. */
export interface BackendSelection {
  provider?: SquadProvider;
  /** @deprecated Prefer `provider: 'gemini'`. Still honoured, and implies it. */
  geminiApiKey?: string;
  anthropicApiKey?: string;
  /** `.squad/` directory, for the persisted preference. */
  squadDir?: string;
  /**
   * Environment to read `SQUAD_PROVIDER` / `GEMINI_API_KEY` from.
   *
   * Injectable so tests never have to mutate `process.env` — vitest shares a
   * process across test files, so a global mutation here leaks into whatever
   * else is running concurrently.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the backend to use, most explicit signal first.
 *
 * The `geminiApiKey` rule is the load-bearing one for back-compat: an
 * *explicitly passed* key means the caller has already chosen Gemini, which
 * keeps every existing `new SquadClient({ geminiApiKey })` call site — and
 * the tests built on them — on their current backend without edits.
 *
 * The `GEMINI_API_KEY` *environment variable* deliberately does not count.
 * Treating it as a choice would pin anyone who merely has one exported to
 * Gemini forever, and the default could never move.
 */
export function resolveProvider(options: BackendSelection): SquadProvider {
  if (options.provider) return options.provider;
  if (options.geminiApiKey) return 'gemini';

  if (options.squadDir) {
    const fromConfig = readProviderPreference(options.squadDir);
    if (fromConfig) return fromConfig;
  }

  const env = options.env ?? process.env;
  const fromEnv = asProvider(env['SQUAD_PROVIDER']);
  if (fromEnv) return fromEnv;

  return 'anthropic';
}

/**
 * Construct the selected backend.
 *
 * The Anthropic backend is imported lazily so that a Gemini user never pays
 * to resolve a package they don't have installed; Gemini stays a static
 * import so existing `vi.mock` of `gemini-client.js` keeps intercepting it.
 */
export async function createBackend(options: BackendSelection): Promise<{
  provider: SquadProvider;
  backend: SquadBackend;
}> {
  const provider = resolveProvider(options);

  if (provider === 'anthropic') {
    const { AnthropicClient } = await import('./anthropic-client.js');
    return { provider, backend: new AnthropicClient(options.anthropicApiKey) };
  }

  const env = options.env ?? process.env;
  const apiKey = options.geminiApiKey ?? env['GEMINI_API_KEY'] ?? '';
  return { provider, backend: new GeminiClient(apiKey) };
}
