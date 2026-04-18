/**
 * Agent spawning — loads charters, builds prompts, and manages spawn lifecycle.
 *
 * Creates SDK sessions via SquadClient, sends the task, and streams the response.
 * Provider selection (copilot/anthropic/gemini) is read from .squad/provider.json.
 */

import { resolveSquad } from '@squad/sdk/resolution';
import { SquadClient } from '@squad/sdk/client';
import type { SquadSession } from '@squad/sdk/client';
import { SquadState, FSStorageProvider } from '@squad/sdk';
import { SessionRegistry } from './sessions.js';
import { dirname, join } from 'node:path';
import type { SquadProviderType } from '@squad/sdk/client';

/** Debug logger — writes to stderr only when SQUAD_DEBUG=1. */
function debugLog(...args: unknown[]): void {
  if (process.env['SQUAD_DEBUG'] === '1') {
    console.error('[SQUAD_DEBUG]', ...args);
  }
}

export interface SpawnOptions {
  /** Wait for completion (sync) or fire-and-track (background) */
  mode: 'sync' | 'background';
  /** Additional system prompt context */
  systemContext?: string;
  /** Tool definitions to register */
  tools?: ToolDefinition[];
  /** SquadClient instance for SDK session creation */
  client?: SquadClient;
  /** Working directory for the session */
  teamRoot?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SpawnResult {
  agentName: string;
  status: 'completed' | 'streaming' | 'error';
  response?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Provider config loader
// ---------------------------------------------------------------------------

interface ProviderJson {
  type?: SquadProviderType;
  anthropic?: { apiKey?: string; defaultModel?: string };
  gemini?: { apiKey?: string; defaultModel?: string };
  copilot?: { cliPath?: string };
}

/**
 * Read .squad/provider.json and return provider options for SquadClient.
 * Falls back to 'copilot' if the file doesn't exist or is malformed.
 */
export function loadProviderConfig(teamRoot: string): {
  provider: SquadProviderType;
  anthropic?: { apiKey?: string; model?: string };
  gemini?: { apiKey?: string; model?: string };
  cliPath?: string;
} {
  try {
    const storage = new FSStorageProvider();
    const raw = storage.readSync(join(teamRoot, '.squad', 'provider.json'));
    if (!raw) return { provider: 'copilot' };
    const cfg: ProviderJson = JSON.parse(raw);
    const provider: SquadProviderType = cfg.type ?? 'copilot';
    return {
      provider,
      anthropic: cfg.anthropic
        ? { apiKey: cfg.anthropic.apiKey, model: cfg.anthropic.defaultModel }
        : undefined,
      gemini: cfg.gemini
        ? { apiKey: cfg.gemini.apiKey, model: cfg.gemini.defaultModel }
        : undefined,
      cliPath: cfg.copilot?.cliPath,
    };
  } catch {
    return { provider: 'copilot' };
  }
}

/**
 * Load agent charter from .squad/agents/{name}/charter.md
 *
 * Reads via SquadState → AgentHandle.charter() so all file access is
 * routed through the StorageProvider abstraction.
 */
export async function loadAgentCharter(agentName: string, teamRoot?: string): Promise<string> {
  let rootDir: string;
  if (teamRoot) {
    rootDir = teamRoot;
  } else {
    const squadDir = resolveSquad();
    if (!squadDir) {
      debugLog('loadAgentCharter: no .squad/ directory found');
      throw new Error('No team found. Run `squad init` to set up your project.');
    }
    rootDir = dirname(squadDir);
  }

  const storage = new FSStorageProvider();
  let state: SquadState;
  try {
    state = await SquadState.create(storage, rootDir);
  } catch {
    debugLog('loadAgentCharter: no .squad/ directory at', rootDir);
    throw new Error('No team found. Run `squad init` to set up your project.');
  }

  try {
    return await state.agents.get(agentName.toLowerCase()).charter();
  } catch (err) {
    debugLog('loadAgentCharter: failed to read charter for', agentName, err);
    throw new Error(`No charter found for "${agentName}". Check that .squad/agents/${agentName.toLowerCase()}/charter.md exists.`);
  }
}

/**
 * Build system prompt for an agent from their charter + optional context
 */
export function buildAgentPrompt(charter: string, options?: { systemContext?: string }): string {
  let prompt = `You are an AI agent on a software development team.\n\nYOUR CHARTER:\n${charter}`;
  if (options?.systemContext) {
    prompt += `\n\nADDITIONAL CONTEXT:\n${options.systemContext}`;
  }
  return prompt;
}

/**
 * Spawn an agent session.
 *
 * When a SquadClient is provided via options.client, creates a real SDK session,
 * sends the task, streams the response, and returns the accumulated result.
 * Without a client, returns a stub result for backward compatibility.
 */
export async function spawnAgent(
  name: string,
  task: string,
  registry: SessionRegistry,
  options: SpawnOptions = { mode: 'sync' }
): Promise<SpawnResult> {
  const teamRoot = options.teamRoot ?? process.cwd();
  const charter = await loadAgentCharter(name, teamRoot);

  const roleMatch = charter.match(/^#\s+\w+\s+—\s+(.+)$/m);
  const role = roleMatch?.[1] ?? 'Agent';

  registry.register(name, role);
  registry.updateStatus(name, 'working');

  try {
    const systemPrompt = buildAgentPrompt(charter, { systemContext: options.systemContext });

    // Use provided client, or auto-create one from .squad/provider.json
    let client = options.client;
    let ownedClient = false;
    if (!client) {
      const providerCfg = loadProviderConfig(teamRoot);
      client = new SquadClient({
        provider: providerCfg.provider,
        anthropic: providerCfg.anthropic,
        gemini: providerCfg.gemini,
        cliPath: providerCfg.cliPath,
      });
      await client.connect();
      ownedClient = true;
    }

    const session: SquadSession = await client.createSession({
      streaming: true,
      systemMessage: { mode: 'append', content: systemPrompt },
      workingDirectory: teamRoot,
    });

    // Accumulate streamed response
    let accumulated = '';
    const onDelta = (event: { type: string; [key: string]: unknown }): void => {
      const val = event['delta'] ?? event['content'];
      if (typeof val === 'string') accumulated += val;
    };

    session.on('message_delta', onDelta);
    try {
      await session.sendMessage({ prompt: task });
    } finally {
      try { session.off('message_delta', onDelta); } catch (err) { debugLog('spawnAgent: failed to remove delta listener:', err); }
    }

    try { await session.close(); } catch (err) { debugLog('spawnAgent: failed to close session for', name, err); }
    if (ownedClient) {
      try { await client.disconnect(); } catch (err) { debugLog('spawnAgent: failed to disconnect owned client:', err); }
    }

    registry.updateStatus(name, 'idle');
    return {
      agentName: name,
      status: 'completed',
      response: accumulated || undefined,
    };
  } catch (error) {
    debugLog('spawnAgent: spawn failed for', name, error);
    registry.updateStatus(name, 'error');
    const msg = error instanceof Error ? error.message : String(error);
    return {
      agentName: name,
      status: 'error',
      error: `Failed to spawn ${name}: ${msg.replace(/^Error:\s*/i, '')}. Try again or run \`squad doctor\`.`,
    };
  }
}
