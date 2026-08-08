/**
 * Vendor keys, read from exactly two places and never inferred.
 *
 * Environment first, then `~/.config/squad/<provider>.json` as written 0600 by
 * `squad auth setup`. The lab's rule everywhere is that a key merely being set
 * does not select a vendor — the arm names its provider and the key is fetched
 * for it — because a harness that picked a provider up from ambient state would
 * be a second way for two runs to differ without saying so.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { VENDORS, type SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

/** The key file `squad auth setup` writes. */
export function keyFileFor(provider: SquadProvider): string {
  return join(homedir(), '.config', 'squad', `${provider}.json`);
}

export function vendorKey(provider: SquadProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[VENDORS[provider].apiKeyEnv];
  if (fromEnv) return fromEnv;
  try {
    return (JSON.parse(readFileSync(keyFileFor(provider), 'utf8')) as { apiKey?: string }).apiKey;
  } catch {
    return undefined;
  }
}
