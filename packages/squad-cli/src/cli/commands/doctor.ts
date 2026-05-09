/**
 * squad doctor — setup validation diagnostic command.
 *
 * Inspects the .squad/ directory (or hub layout) and reports
 * the health of every expected file / convention. Always exits 0
 * because this is a diagnostic tool, not a gate.
 *
 * Inspired by @spboyer (Shayne Boyer)'s doctor command in DeDuva/squad (upstream) #131.
 *
 * @module cli/commands/doctor
 */

import path from 'node:path';
import { FSStorageProvider } from '@deduvafork/squad-sdk';

const storage = new FSStorageProvider();

/** Result of a single diagnostic check. */
export interface DoctorCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  /** Optional severity hint for display; keeps the status union stable. */
  severity?: 'info';
}

/** Detected squad layout mode. */
export type DoctorMode = 'local' | 'remote' | 'hub';

/** Resolved mode + base directory for the squad. */
interface ModeInfo {
  mode: DoctorMode;
  squadDir: string;
  /** Only set when mode === 'remote' */
  teamRoot?: string;
}

// ── helpers ─────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
  return storage.existsSync(p);
}

function isDirectory(p: string): boolean {
  return storage.isDirectorySync(p);
}

function tryReadJson(p: string): unknown | undefined {
  try {
    const raw = storage.readSync(p);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── mode detection ──────────────────────────────────────────────────

function detectMode(cwd: string): ModeInfo {
  const squadDir = path.join(cwd, '.squad');
  const configPath = path.join(squadDir, 'config.json');

  // Remote mode: config.json exists with teamRoot
  if (fileExists(configPath)) {
    const cfg = tryReadJson(configPath);
    if (cfg && typeof cfg === 'object' && 'teamRoot' in cfg) {
      const raw = (cfg as Record<string, unknown>)['teamRoot'];
      if (typeof raw === 'string' && raw.length > 0) {
        return { mode: 'remote', squadDir, teamRoot: raw };
      }
    }
  }

  // Hub mode: squad-hub.json in cwd
  if (fileExists(path.join(cwd, 'squad-hub.json'))) {
    return { mode: 'hub', squadDir };
  }

  // Default: local
  return { mode: 'local', squadDir };
}

// ── individual checks ───────────────────────────────────────────────

function checkSquadDir(squadDir: string): DoctorCheck {
  const exists = isDirectory(squadDir);
  return {
    name: '.squad/ directory exists',
    status: exists ? 'pass' : 'fail',
    message: exists ? 'directory present' : 'directory not found',
  };
}

function checkConfigJson(squadDir: string): DoctorCheck | undefined {
  const configPath = path.join(squadDir, 'config.json');
  if (!fileExists(configPath)) return undefined; // optional file — skip

  const data = tryReadJson(configPath);
  if (data === undefined) {
    return {
      name: 'config.json valid',
      status: 'fail',
      message: 'file exists but is not valid JSON',
    };
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'teamRoot' in data &&
    typeof (data as Record<string, unknown>)['teamRoot'] !== 'string'
  ) {
    return {
      name: 'config.json valid',
      status: 'fail',
      message: 'teamRoot must be a string',
    };
  }

  return {
    name: 'config.json valid',
    status: 'pass',
    message: 'parses as JSON, schema OK',
  };
}

function checkAbsoluteTeamRoot(squadDir: string): DoctorCheck | undefined {
  const configPath = path.join(squadDir, 'config.json');
  if (!fileExists(configPath)) return undefined;

  const data = tryReadJson(configPath) as Record<string, unknown> | undefined;
  if (!data || typeof data['teamRoot'] !== 'string') return undefined;

  const teamRoot = data['teamRoot'] as string;
  if (path.isAbsolute(teamRoot)) {
    return {
      name: 'absolute path warning',
      status: 'warn',
      message: `teamRoot is absolute (${teamRoot}) — prefer relative paths for portability. Edit .squad/config.json to use a relative path.`,
    };
  }
  return undefined;
}

function checkTeamRootResolves(squadDir: string, teamRoot: string): DoctorCheck {
  const resolved = path.isAbsolute(teamRoot)
    ? teamRoot
    : path.resolve(path.dirname(squadDir), teamRoot);
  const exists = isDirectory(resolved);
  return {
    name: 'team root resolves',
    status: exists ? 'pass' : 'fail',
    message: exists ? `resolved to ${resolved}` : `directory not found: ${resolved}`,
  };
}

function checkTeamMd(squadDir: string): DoctorCheck {
  const teamPath = path.join(squadDir, 'team.md');
  if (!fileExists(teamPath)) {
    return { name: 'team.md found with ## Members header', status: 'fail', message: 'file not found' };
  }
  const content = storage.readSync(teamPath) ?? '';
  if (!content.includes('## Members')) {
    return { name: 'team.md found with ## Members header', status: 'warn', message: 'file exists but missing ## Members header' };
  }
  return { name: 'team.md found with ## Members header', status: 'pass', message: 'file present, header found' };
}

function checkRoutingMd(squadDir: string): DoctorCheck {
  const exists = fileExists(path.join(squadDir, 'routing.md'));
  return {
    name: 'routing.md found',
    status: exists ? 'pass' : 'fail',
    message: exists ? 'file present' : 'file not found',
  };
}

function checkAgentsDir(squadDir: string): DoctorCheck {
  const agentsDir = path.join(squadDir, 'agents');
  if (!isDirectory(agentsDir)) {
    return { name: 'agents/ directory exists', status: 'fail', message: 'directory not found' };
  }
  let count = 0;
  try {
    for (const entry of storage.listSync(agentsDir)) {
      if (storage.isDirectorySync(path.join(agentsDir, entry))) count++;
    }
  } catch { /* empty */ }
  return {
    name: 'agents/ directory exists',
    status: 'pass',
    message: `directory present (${count} agent${count === 1 ? '' : 's'})`,
  };
}

function checkCastingRegistry(squadDir: string): DoctorCheck {
  const registryPath = path.join(squadDir, 'casting', 'registry.json');
  if (!fileExists(registryPath)) {
    return { name: 'casting/registry.json exists', status: 'fail', message: 'file not found' };
  }
  const data = tryReadJson(registryPath);
  if (data === undefined) {
    return { name: 'casting/registry.json exists', status: 'fail', message: 'file exists but is not valid JSON' };
  }
  return { name: 'casting/registry.json exists', status: 'pass', message: 'file present, valid JSON' };
}

function checkDecisionsMd(squadDir: string): DoctorCheck {
  const exists = fileExists(path.join(squadDir, 'decisions.md'));
  return {
    name: 'decisions.md exists',
    status: exists ? 'pass' : 'fail',
    message: exists ? 'file present' : 'file not found',
  };
}

/**
 * Report the last detected rate limit, if any, by reading the status file
 * written by the shell when a rate limit error is caught.
 */
function checkRateLimitStatus(squadDir: string): DoctorCheck | undefined {
  const statusPath = path.join(squadDir, 'rate-limit-status.json');
  if (!fileExists(statusPath)) return undefined;

  const data = tryReadJson(statusPath) as Record<string, unknown> | undefined;
  if (!data) {
    return {
      name: 'rate limit status',
      status: 'warn',
      message: 'rate-limit-status.json exists but could not be parsed',
    };
  }

  const ts = typeof data['timestamp'] === 'string' ? new Date(data['timestamp']) : null;
  const retryAfter = typeof data['retryAfter'] === 'number' ? data['retryAfter'] : null;
  const model = typeof data['model'] === 'string' ? data['model'] : null;

  const age = ts ? Math.floor((Date.now() - ts.getTime()) / 1000) : null;
  const ageStr = age !== null ? ` (${formatAge(age)} ago)` : '';
  const modelStr = model ? ` on model: ${model}` : '';
  const retryStr = retryAfter ? ` — retry after ${retryAfter}s` : '';

  // If last rate limit was more than 4 hours ago, treat as stale info (pass)
  const stale = age !== null && age > 4 * 3600;

  return {
    name: 'rate limit status',
    status: stale ? 'pass' : 'warn',
    message: stale
      ? `Last rate limit${ageStr}${modelStr} — appears resolved. Run \`squad economy on\` to reduce future risk.`
      : `Rate limit detected${ageStr}${modelStr}${retryStr}. Run \`squad economy on\` to switch to cheaper models.`,
  };
}

function formatAge(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    return `${h}h`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    return `${m}m`;
  }
  return `${seconds}s`;
}

// ── environment checks ─────────────────────────────────────────────

/**
 * Check that Node.js is ≥22.5.0.
 * Accepts an optional version string for testing.
 */
export function checkNodeVersion(nodeVersion?: string): DoctorCheck {
  const version = nodeVersion ?? process.versions.node;
  const parts = version.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const ok = major > 22 || (major === 22 && minor >= 5);
  return {
    name: 'Node.js ≥22.5.0',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `v${version}`
      : `v${version} — requires ≥22.5.0, upgrade at https://nodejs.org/en/download`,
  };
}

/**
 * Check that a Gemini API key is configured (env var or stored config).
 */
async function checkGeminiAuth(): Promise<DoctorCheck> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { existsSync, readFileSync } = await import('node:fs');

  let apiKey = process.env['GEMINI_API_KEY'];

  if (!apiKey) {
    const configFile = join(homedir(), '.config', 'squad', 'gemini.json');
    if (existsSync(configFile)) {
      try {
        const parsed = JSON.parse(readFileSync(configFile, 'utf-8'));
        if (typeof parsed.apiKey === 'string') apiKey = parsed.apiKey;
      } catch {
        // ignore
      }
    }
  }

  if (!apiKey) {
    return {
      name: 'Gemini API key',
      status: 'fail',
      message: 'not configured — run: squad auth setup --provider=gemini --key YOUR_KEY',
    };
  }

  // Validate the key
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const source = process.env['SQUAD_GEMINI_KEY_SOURCE']
        ? process.env['SQUAD_GEMINI_KEY_SOURCE']
        : process.env['GEMINI_API_KEY']
          ? 'GEMINI_API_KEY env var'
          : '~/.config/squad/gemini.json';
      return { name: 'Gemini API key', status: 'pass', message: `valid (source: ${source})` };
    }
    return {
      name: 'Gemini API key',
      status: 'fail',
      message: `key found but validation failed (HTTP ${res.status}) — run: squad auth setup --provider=gemini --key YOUR_KEY`,
    };
  } catch (err) {
    return {
      name: 'Gemini API key',
      status: 'warn',
      message: `key found but connectivity check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check that the local esbuild bundle exists and is runnable.
 * Only applies inside the Squad source checkout; skipped in user projects.
 */
function checkBundle(cwd: string): DoctorCheck {
  const isSrcCheckout = fileExists(path.join(cwd, 'packages', 'squad-cli', 'package.json'));
  if (!isSrcCheckout) {
    return { name: 'squad.js bundle', status: 'pass', message: 'skipped (not a squad source checkout)' };
  }
  const bundlePath = path.join(cwd, 'packages', 'squad-cli', 'dist', 'squad.js');
  if (!fileExists(bundlePath)) {
    return {
      name: 'squad.js bundle',
      status: 'fail',
      message: 'not found — run: npm run build',
    };
  }
  return { name: 'squad.js bundle', status: 'pass', message: bundlePath };
}

function checkSquadAgentMd(cwd: string): DoctorCheck {
  const agentMdPath = path.join(cwd, '.github', 'agents', 'squad.agent.md');
  if (!fileExists(agentMdPath)) {
    return {
      name: '.github/agents/squad.agent.md',
      status: 'fail',
      message: "file not found — run 'squad upgrade' to restore it",
    };
  }
  try {
    const content = storage.readSync(agentMdPath) ?? '';
    if (content.trim().length === 0) {
      return {
        name: '.github/agents/squad.agent.md',
        status: 'warn',
        message: "file is empty — run 'squad upgrade' to restore it",
      };
    }
  } catch {
    return {
      name: '.github/agents/squad.agent.md',
      status: 'warn',
      message: "file is empty — run 'squad upgrade' to restore it",
    };
  }
  return {
    name: '.github/agents/squad.agent.md',
    status: 'pass',
    message: 'file present',
  };
}

// ── public API ──────────────────────────────────────────────────────

/**
 * Run all doctor checks for the given working directory.
 * Returns an array of check results — never throws for check failures.
 */
export async function runDoctor(cwd?: string): Promise<DoctorCheck[]> {
  const resolvedCwd = cwd ?? process.cwd();
  const { mode, squadDir, teamRoot } = detectMode(resolvedCwd);
  const checks: DoctorCheck[] = [];

  // 1. .squad/ directory
  checks.push(checkSquadDir(squadDir));

  // 2. config.json (if present)
  const configCheck = checkConfigJson(squadDir);
  if (configCheck) checks.push(configCheck);

  // 3. Absolute path warning
  const absWarn = checkAbsoluteTeamRoot(squadDir);
  if (absWarn) checks.push(absWarn);

  // 4. Remote team root resolution
  if (mode === 'remote' && teamRoot) {
    checks.push(checkTeamRootResolves(squadDir, teamRoot));
  }

  // 5–9 standard files (only if .squad/ exists)
  if (isDirectory(squadDir)) {
    checks.push(checkTeamMd(squadDir));
    checks.push(checkRoutingMd(squadDir));
    checks.push(checkAgentsDir(squadDir));
    checks.push(checkCastingRegistry(squadDir));
    checks.push(checkDecisionsMd(squadDir));
    const rateLimitCheck = checkRateLimitStatus(squadDir);
    if (rateLimitCheck) checks.push(rateLimitCheck);
  }

  // 10. Agent discovery file
  checks.push(checkSquadAgentMd(resolvedCwd));

  // 11. Node.js version
  checks.push(checkNodeVersion());

  // 12. Gemini API key (async — validates connectivity)
  checks.push(await checkGeminiAuth());

  // 13. Local bundle (airlock mode)
  checks.push(checkBundle(resolvedCwd));

  return checks;
}

/**
 * Detect the squad mode for the given working directory.
 * Exported for tests and display.
 */
export function getDoctorMode(cwd?: string): DoctorMode {
  return detectMode(cwd ?? process.cwd()).mode;
}

// ── CLI output ──────────────────────────────────────────────────────

const STATUS_ICON: Record<DoctorCheck['status'], string> = {
  pass: '✅',
  fail: '❌',
  warn: '⚠️',
};

/**
 * Print doctor results to stdout. Intended for CLI use.
 */
export function printDoctorReport(checks: DoctorCheck[], mode: DoctorMode): void {
  console.log('\n🩺 Squad Doctor');
  console.log('═══════════════\n');
  console.log(`Mode: ${mode}\n`);

  for (const c of checks) {
    const icon = c.severity === 'info' ? 'ℹ️' : STATUS_ICON[c.status];
    console.log(`${icon}  ${c.name} — ${c.message}`);
  }

  const passed = checks.filter(c => c.status === 'pass').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn' && c.severity !== 'info').length;
  const infos = checks.filter(c => c.severity === 'info').length;

  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${warned} warnings, ${infos} info\n`);
}

/**
 * CLI entry point — run doctor and print results.
 */
export async function doctorCommand(cwd?: string): Promise<void> {
  const resolvedCwd = cwd ?? process.cwd();
  const mode = getDoctorMode(resolvedCwd);
  const checks = await runDoctor(resolvedCwd);
  printDoctorReport(checks, mode);
}
