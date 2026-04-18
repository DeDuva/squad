/**
 * Self-update check — background version check with notification.
 *
 * Non-blocking startup check that queries the git remote for any new commits
 * on the default branch and displays a passive banner when updates are available.
 * Results are cached for 24 hours.
 *
 * Disable with: SQUAD_NO_UPDATE_CHECK=1
 *
 * @module cli/self-update
 */

import path from 'node:path';
import os from 'node:os';
import { FSStorageProvider } from '@squad/sdk';

const storage = new FSStorageProvider();
import { compareVersions } from './upgrade.js';
import { BOLD, RESET, DIM, YELLOW } from './core/output.js';

const REMOTE_URL = 'https://api.github.com/repos/DeDuva/squad/commits?per_page=1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000; // 3 seconds

interface CacheData {
  latestSha: string;
  checkedAt: number;
}

/** Directory for squad CLI cache files. */
function getCacheDir(): string {
  const base = process.env.APPDATA
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'squad-cli');
}

function getCachePath(): string {
  return path.join(getCacheDir(), 'update-check.json');
}

/** Read cached update check result, if still valid. */
function readCache(): CacheData | null {
  try {
    const raw = storage.readSync(getCachePath());
    if (!raw) return null;
    const data: CacheData = JSON.parse(raw);
    if (Date.now() - data.checkedAt < CACHE_TTL_MS) {
      return data;
    }
  } catch {
    // Cache missing, corrupt, or expired — ignore
  }
  return null;
}

/** Write update check result to cache. */
function writeCache(data: CacheData): void {
  try {
    const dir = getCacheDir();
    storage.mkdirSync(dir, { recursive: true });
    storage.writeSync(getCachePath(), JSON.stringify(data));
  } catch {
    // Non-critical — silently ignore write failures
  }
}

/** Fetch latest commit SHA from GitHub with timeout. */
async function fetchLatestSha(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REMOTE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as Array<{ sha?: string }>;
    return data[0]?.sha ?? null;
  } catch {
    // Network failure, timeout, or parse error — silently ignore
    return null;
  }
}

/** Get the current local HEAD SHA via git. */
function getLocalSha(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Check for updates and print a banner if the remote has new commits.
 *
 * This function is designed to be fire-and-forget: it never throws,
 * never blocks the shell, and silently no-ops on any failure.
 *
 * @param _currentVersion - The currently running CLI version (kept for API compat)
 */
export async function notifyIfUpdateAvailable(_currentVersion: string): Promise<void> {
  try {
    // Respect opt-out
    if (process.env.SQUAD_NO_UPDATE_CHECK === '1') return;

    // Check cache first
    const cached = readCache();
    let latestSha: string;

    if (cached) {
      latestSha = cached.latestSha;
    } else {
      const fetched = await fetchLatestSha();
      if (!fetched) return;
      latestSha = fetched;
      writeCache({ latestSha, checkedAt: Date.now() });
    }

    const localSha = getLocalSha();
    if (localSha && latestSha && !latestSha.startsWith(localSha.slice(0, 7))) {
      console.log(
        `\n${YELLOW}⚡${RESET} ${BOLD}Squad updates available${RESET} ${DIM}(remote has new commits)${RESET}` +
        `\n   Run: ${BOLD}git pull && npm run build${RESET}\n`,
      );
    }
  } catch {
    // Absolute safety net — never crash the CLI for an update check
  }
}
