#!/usr/bin/env node
/**
 * scripts/architectural-review.mjs
 *
 * Scans the diff between a base ref and HEAD for architectural concerns.
 * Outputs JSON { findings, summary } to stdout. Always exits with code 0.
 *
 * Usage:
 *   node scripts/architectural-review.mjs [base-ref]
 */

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

function parseAddedLines(patch) {
  const result = new Map();
  let currentFile = null;

  for (const rawLine of patch.split('\n')) {
    const fileMatch = rawLine.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!result.has(currentFile)) result.set(currentFile, []);
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++') && currentFile) {
      result.get(currentFile).push(rawLine.slice(1));
    }
  }
  return result;
}

function parseDeletedFiles(patch) {
  const deleted = [];
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('--- a/') && i + 1 < lines.length && lines[i + 1] === '+++ /dev/null') {
      deleted.push(lines[i].slice(6));
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const BOOTSTRAP_PREFIX = 'packages/squad-cli/src/cli/core/';

const CLI_TO_SDK_SRC = /from\s+['"][^'"]*(?:squad-sdk|squad\/sdk)\/src\//;
const SDK_TO_CLI_SRC = /from\s+['"][^'"]*(?:squad-cli|squad\/cli)\/src\//;
const CLI_TO_SDK_REQUIRE = /require\(['"][^'"]*(?:squad-sdk|squad\/sdk)\/src\//;
const SDK_TO_CLI_REQUIRE = /require\(['"][^'"]*(?:squad-cli|squad\/cli)\/src\//;

const TEMPLATE_FILES = [
  '.github/agents/squad.agent.md',
  '.github/agents/',
  'templates/',
];

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
const addedLines = parseAddedLines(patch);
const deletedFiles = parseDeletedFiles(patch);

const findings = [];

// 1. Cross-package imports
const crossPackageFiles = { 'cli-to-sdk': new Set(), 'sdk-to-cli': new Set() };
for (const [file, lines] of addedLines) {
  const isCliFile = file.startsWith('packages/squad-cli/');
  const isSdkFile = file.startsWith('packages/squad-sdk/');
  if (!isCliFile && !isSdkFile) continue;

  for (const line of lines) {
    if (isCliFile && (CLI_TO_SDK_SRC.test(line) || CLI_TO_SDK_REQUIRE.test(line))) {
      crossPackageFiles['cli-to-sdk'].add(file);
    }
    if (isSdkFile && (SDK_TO_CLI_SRC.test(line) || SDK_TO_CLI_REQUIRE.test(line))) {
      crossPackageFiles['sdk-to-cli'].add(file);
    }
  }
}
for (const [direction, files] of Object.entries(crossPackageFiles)) {
  if (files.size > 0) {
    findings.push({
      category: 'cross-package-import',
      severity: 'error',
      message: `Direct src/ import across package boundary (${direction}) — use published package entry points`,
      files: [...files],
    });
  }
}

// 2. Bootstrap area modifications
const bootstrapFiles = [...addedLines.keys()].filter(f => f.startsWith(BOOTSTRAP_PREFIX));
if (bootstrapFiles.length > 0) {
  findings.push({
    category: 'bootstrap-area',
    severity: 'warning',
    message: 'Bootstrap area (squad-cli/src/cli/core/) modified — verify no new external dependencies introduced',
    files: bootstrapFiles,
  });
}

// 3. File deletions
if (deletedFiles.length > 0) {
  findings.push({
    category: 'file-deletion',
    severity: 'info',
    message: 'Files deleted — confirm removal is intentional',
    files: deletedFiles,
  });
}

// 4. Export surface changes (index.ts at package roots)
const exportFiles = [...addedLines.keys()].filter(f =>
  (f === 'packages/squad-sdk/src/index.ts' || f === 'packages/squad-cli/src/index.ts')
);
if (exportFiles.length > 0) {
  findings.push({
    category: 'export-surface',
    severity: 'info',
    message: 'Package export surface changed — review for breaking changes',
    files: exportFiles,
  });
}

// 5. Template sync
const templateFiles = [...addedLines.keys()].filter(f =>
  TEMPLATE_FILES.some(t => f.startsWith(t))
);
if (templateFiles.length > 0) {
  findings.push({
    category: 'template-sync',
    severity: 'info',
    message: 'Template files modified — ensure downstream projects are synced',
    files: templateFiles,
  });
}

// 6. Sweeping refactor (large single-commit changes across many files)
const changedFileCount = addedLines.size + deletedFiles.length;
if (changedFileCount >= 20) {
  findings.push({
    category: 'sweeping-refactor',
    severity: 'warning',
    message: `Large change touching ${changedFileCount} files — consider splitting or adding context in PR description`,
    files: [],
  });
}

const errorCount = findings.filter(f => f.severity === 'error').length;
const warnCount = findings.filter(f => f.severity === 'warning').length;

const summary = findings.length === 0
  ? '✅ No architectural concerns found'
  : `🏗 ${findings.length} concern(s): ${errorCount} error(s), ${warnCount} warning(s)`;

console.log(JSON.stringify({ findings, summary }, null, 2));
process.exit(0);
