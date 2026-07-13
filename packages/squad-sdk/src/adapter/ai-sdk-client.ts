/**
 * AI SDK-backed client for Squad — factory for AiSdkSession, replacing
 * GeminiClient. Holds both provider API keys and dispatches per-session by
 * model-ID prefix (resolveProvider in ai-sdk-session.ts).
 *
 * @module adapter/ai-sdk-client
 */

import type { SquadBackendClient } from './backend.js';
import type { SquadSessionConfig, SquadGetAuthStatusResponse, SquadModelInfo } from './types.js';
import { AiSdkSession, resolveProvider } from './ai-sdk-session.js';
import { ErrorFactory } from './errors.js';

export interface AiSdkClientApiKeys {
  gemini?: string;
  anthropic?: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export class AiSdkClient implements SquadBackendClient {
  private readonly apiKeys: AiSdkClientApiKeys;
  private connected = false;

  constructor(apiKeys: AiSdkClientApiKeys) {
    this.apiKeys = apiKeys;
  }

  async start(): Promise<void> {
    if (!this.apiKeys.gemini && !this.apiKeys.anthropic) {
      throw new Error(
        'No API key is set for any provider. Run "squad auth setup --provider=gemini" ' +
        'or "squad auth setup --provider=anthropic", or set GEMINI_API_KEY / ANTHROPIC_API_KEY.',
      );
    }
    // No eager connectivity check here (two providers, no single "the" provider
    // to ping) — auth failures surface on first real sendMessage call, or via
    // an explicit getAuthStatus()/doctor check.
    this.connected = true;
  }

  async stop(): Promise<Error[]> {
    this.connected = false;
    return [];
  }

  isStarted(): boolean {
    return this.connected;
  }

  createSession(config: SquadSessionConfig): AiSdkSession {
    const model = config.model ?? 'gemini-flash-latest';
    const provider = resolveProvider(model);
    const apiKey = provider === 'anthropic' ? this.apiKeys.anthropic : this.apiKeys.gemini;

    if (!apiKey) {
      throw ErrorFactory.wrap(
        new Error(`${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY'} is not set for model "${model}".`),
        { operation: 'createSession', model },
      );
    }

    return new AiSdkSession(provider, apiKey, config);
  }

  async getAuthStatus(): Promise<SquadGetAuthStatusResponse> {
    const checks: string[] = [];

    if (this.apiKeys.gemini) {
      const ok = await checkGeminiKey(this.apiKeys.gemini);
      if (ok) checks.push('Gemini');
    }
    if (this.apiKeys.anthropic) {
      const ok = await checkAnthropicKey(this.apiKeys.anthropic);
      if (ok) checks.push('Anthropic');
    }

    if (checks.length === 0) {
      return { isAuthenticated: false, statusMessage: 'No valid API key configured for any provider' };
    }
    return { isAuthenticated: true, authType: 'api-key', statusMessage: `Valid keys: ${checks.join(', ')}` };
  }

  // Model list comes from the local catalog (config/models.ts); no live listing needed.
  async listModels(): Promise<SquadModelInfo[]> {
    return [];
  }
}

async function checkGeminiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${apiKey}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE}/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
