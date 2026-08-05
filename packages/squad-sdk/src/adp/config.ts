/**
 * Where Squad finds the ADP server it records into.
 *
 * The block lives in `.squad/config.json` beside the `github` override that
 * module already reads:
 *
 * ```json
 * { "adp": { "url": "http://127.0.0.1:3000", "repo": "owner/name", "tokenEnv": "ADP_TOKEN" } }
 * ```
 *
 * The token is **named** here, never written here. `.squad/config.json` is
 * committed, and both this repo and ADP are public — a config file that can
 * hold a credential eventually holds one. `tokenEnv` names the environment
 * variable instead, so the checked-in artifact says where to look rather than
 * what the secret is.
 *
 * Absent or incomplete config resolves to `undefined`, and every caller treats
 * that as "do not record". Recording is an opt-in that must cost nothing —
 * behaviourally or operationally — when it is off.
 *
 * @module adp/config
 */

import { join } from 'node:path';
import { FSStorageProvider } from '../storage/fs-storage-provider.js';
import { AdpClient } from './client.js';

const storage = new FSStorageProvider();

export interface AdpConfig {
  url: string;
  owner: string;
  repo: string;
  /** Name of the environment variable holding the token. Never the token. */
  tokenEnv: string;
}

/** The name Squad reports as the writer of a trajectory chain. */
export const PRODUCER_ID = 'squad-sdk';

/**
 * Read the `adp` block from `.squad/config.json`, or `undefined` if it is
 * missing, malformed, or incomplete. Never throws: a broken config must not
 * take down the assignment it was only supposed to observe.
 */
export function readAdpConfig(repoRoot: string): AdpConfig | undefined {
  const configPath = join(repoRoot, '.squad', 'config.json');
  if (!storage.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(storage.readSync(configPath) ?? '') as Record<string, unknown>;
    if (!parsed.adp || typeof parsed.adp !== 'object') return undefined;
    const adp = parsed.adp as Record<string, unknown>;
    const url = typeof adp.url === 'string' ? adp.url : undefined;
    const repo = typeof adp.repo === 'string' ? adp.repo : undefined;
    const tokenEnv = typeof adp.tokenEnv === 'string' ? adp.tokenEnv : 'ADP_TOKEN';
    if (!url || !repo) return undefined;
    const [owner, name] = repo.split('/');
    if (!owner || !name) return undefined;
    return { url, owner, repo: name, tokenEnv };
  } catch {
    return undefined;
  }
}

/**
 * Build a client from the config plus the token in the named environment
 * variable. `undefined` when either half is missing — configured-but-unset is
 * as much "not recording" as unconfigured, and guessing at a token would turn
 * a missing secret into a wall of 401s during someone's assignment.
 */
export function resolveAdpClient(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { client: AdpClient; config: AdpConfig } | undefined {
  const config = readAdpConfig(repoRoot);
  if (!config) return undefined;
  const token = env[config.tokenEnv];
  if (!token) return undefined;
  return {
    client: new AdpClient({ baseUrl: config.url, token, owner: config.owner, repo: config.repo }),
    config,
  };
}
