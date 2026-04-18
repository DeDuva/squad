#!/usr/bin/env node
/**
 * scripts/check-squad-leakage.mjs
 *
 * Checks whether any .squad/ files appear in the diff between a base ref
 * and HEAD. These files are gitignored by convention and should never be
 * committed (they contain API keys and local provider config).
 *
 * Outputs JSON { leaked, files } to stdout. Always exits with code 0.
 *
 * Usage:
 *   node scripts/check-squad-leakage.mjs [base-ref]
 */

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGit(args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function resolveBaseRef(arg) {
  if (arg) {
    try {
      execSync(`git rev-parse ${arg}`, { stdio: 'pipe' });
      return arg;
    } catch {
      return 'HEAD';
    }
  }
  for (const ref of ['origin/main', 'origin/dev', 'main', 'dev']) {
    try {
      execSync(`git rev-parse ${ref}`, { stdio: 'pipe' });
      return ref;
    } catch { /* try next */ }
  }
  return 'HEAD';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const baseRef = resolveBaseRef(process.argv[2]);
const patch = runGit(`diff ${baseRef}...HEAD`);

const leakedFiles = new Set();

for (const line of patch.split('\n')) {
  const match = line.match(/^\+\+\+ b\/(\.squad\/.+)/);
  if (match) {
    leakedFiles.add(match[1]);
  }
}

const files = [...leakedFiles];
const leaked = files.length > 0;

console.log(JSON.stringify({ leaked, files }, null, 2));

if (!leaked) {
  console.log('No .squad/ file leakage detected. ✅');
} else {
  console.log(`⚠️  ${files.length} .squad/ file(s) detected in diff — these should be gitignored.`);
}

process.exit(0);
