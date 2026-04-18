#!/usr/bin/env node
/**
 * scripts/check-bootstrap-deps.mjs
 *
 * Checks that files in packages/squad-cli/src/cli/core/ only import
 * node built-in modules or relative paths (no external npm packages).
 *
 * These files run during CLI bootstrap before any npm install, so they
 * must not depend on packages that may not yet be installed.
 *
 * Outputs JSON { pass, violations } to stdout. Exits 0 on pass, 1 on failure.
 *
 * Usage:
 *   node scripts/check-bootstrap-deps.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROTECTED_DIR = join(REPO_ROOT, 'packages', 'squad-cli', 'src', 'cli', 'core');

// Load workspace package names so they are never flagged as external deps
function loadWorkspacePackageNames() {
  const names = new Set();
  try {
    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    const workspaces = rootPkg.workspaces ?? [];
    for (const pattern of workspaces) {
      const dir = pattern.replace(/\/\*$/, '');
      try {
        const entries = readdirSync(join(REPO_ROOT, dir));
        for (const entry of entries) {
          try {
            const pkgPath = join(REPO_ROOT, dir, entry, 'package.json');
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            if (pkg.name) names.add(pkg.name);
          } catch { /* not a package */ }
        }
      } catch { /* directory not found */ }
    }
  } catch { /* no root package.json */ }
  return names;
}

const WORKSPACE_PACKAGES = loadWorkspacePackageNames();

// ---------------------------------------------------------------------------
// Built-in detection
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'test', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  const base = specifier.split('/')[0];
  return NODE_BUILTINS.has(base);
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

const IMPORT_PATTERNS = [
  /(?:^|\s)import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function findImports(line) {
  const imports = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      imports.push(match[1]);
    }
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

let files;
try {
  files = readdirSync(PROTECTED_DIR);
} catch {
  // Directory doesn't exist — nothing to protect
  console.log(JSON.stringify({ pass: true, violations: [] }, null, 2));
  console.log('Bootstrap protection: directory not found, skipping check. Allowed: node:* and relative imports.');
  process.exit(0);
}

const violations = [];

for (const filename of files) {
  if (!/\.(ts|js|mjs|cjs)$/.test(filename)) continue;
  const filePath = join(PROTECTED_DIR, filename);
  const relPath = `packages/squad-cli/src/cli/core/${filename}`;
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    continue;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const specifier of findImports(trimmed)) {
      if (!isNodeBuiltin(specifier) && !isRelativeImport(specifier) && !WORKSPACE_PACKAGES.has(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))) {
        violations.push({ file: relPath, specifier });
      }
    }
  }
}

const pass = violations.length === 0;
console.log(JSON.stringify({ pass, violations }, null, 2));

if (pass) {
  console.log('Bootstrap protection: all core files use only node:* and relative imports. ✅');
} else {
  console.log(`Bootstrap protection: ${violations.length} violation(s) found — external imports not allowed in core bootstrap files.`);
}

process.exit(pass ? 0 : 1);
