#!/usr/bin/env node
/**
 * scripts/security-review.mjs
 *
 * Scans the diff between a base ref and HEAD for common security issues.
 * Outputs JSON { findings, summary } to stdout. Always exits with code 0.
 *
 * Usage:
 *   node scripts/security-review.mjs [base-ref]
 *
 * If base-ref is omitted, auto-detects origin/main → origin/dev → HEAD.
 */

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Diff parsing (mirrors the logic unit-tested in security-review.test.ts)
// ---------------------------------------------------------------------------

function parseAddedLines(patch) {
  const result = new Map();
  let currentFile = null;
  let hunkLine = 0;

  for (const rawLine of patch.split('\n')) {
    const fileMatch = rawLine.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!result.has(currentFile)) result.set(currentFile, []);
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      hunkLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++') && currentFile) {
      result.get(currentFile).push({ line: hunkLine, text: rawLine.slice(1) });
      hunkLine++;
    } else if (!rawLine.startsWith('-')) {
      hunkLine++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    category: 'eval-usage',
    severity: 'error',
    pattern: /\beval\s*\(/,
    message: 'Use of eval() detected — potential code injection risk',
    fileFilter: (f) => /\.(js|ts|mjs|cjs)$/.test(f),
  },
  {
    category: 'command-injection',
    severity: 'error',
    pattern: /exec\s*\(\s*`|exec\s*\(\s*['"].*\$\{/,
    message: 'exec() with dynamic string — potential command injection',
    fileFilter: (f) => /\.(js|ts|mjs|cjs)$/.test(f),
  },
  {
    category: 'unsafe-git',
    severity: 'warning',
    pattern: /git\s+add\s+\.|git\s+add\s+-A|git\s+commit\s+-a|git\s+push\s+--force|--force-with-lease/,
    message: 'Unsafe git operation detected',
    fileFilter: () => true,
  },
  {
    category: 'secrets-reference',
    severity: 'warning',
    pattern: /secrets\./,
    exclude: /secrets\.GITHUB_TOKEN/,
    message: 'Non-standard secrets reference — verify it is intentional',
    fileFilter: (f) => /\.(yml|yaml)$/.test(f),
  },
  {
    category: 'pii-env-var',
    severity: 'warning',
    pattern: /PASSWORD|SECRET_KEY|PRIVATE_KEY|API_KEY|ACCESS_TOKEN|CREDENTIALS|AUTH_TOKEN/i,
    message: 'Potential PII or credential environment variable',
    fileFilter: (f) => /\.(yml|yaml|env|sh|bash)$/.test(f),
  },
  {
    category: 'workflow-permissions',
    severity: 'info',
    pattern: /permissions:/,
    message: 'Workflow permissions change — review scope',
    fileFilter: (f) => /\.github\/workflows\//.test(f),
  },
  {
    category: 'pr-target-checkout',
    severity: 'error',
    pattern: /pull_request_target/,
    message: 'pull_request_target may expose secrets to untrusted PR code',
    fileFilter: (f) => /\.github\/workflows\//.test(f),
  },
  {
    category: 'skill-credentials',
    severity: 'warning',
    pattern: /password|api.key|secret|token/i,
    message: 'Potential credential reference in skill file',
    fileFilter: (f) => /skills\//.test(f) && /\.(md|txt)$/.test(f),
  },
  {
    category: 'skill-credential-file-read',
    severity: 'warning',
    pattern: /\.ssh\/|\.aws\/credentials|\.netrc/,
    message: 'Reading credential file path in skill',
    fileFilter: (f) => /skills\//.test(f),
  },
  {
    category: 'skill-download-exec',
    severity: 'warning',
    pattern: /curl.*\|\s*(?:sh|bash)|wget.*\|\s*(?:sh|bash)/,
    message: 'Download-and-execute pattern in skill',
    fileFilter: (f) => /skills\//.test(f),
  },
  {
    category: 'skill-privilege-escalation',
    severity: 'warning',
    pattern: /\bsudo\b/,
    message: 'Privilege escalation (sudo) in skill',
    fileFilter: (f) => /skills\//.test(f),
  },
  {
    category: 'new-dependency',
    severity: 'info',
    pattern: /"[^"]+"\s*:\s*"[^"]+"/,
    message: 'New dependency added — review for supply chain risk',
    fileFilter: (f) => /(?:^|[/\\])package\.json$/.test(f) && !/node_modules/.test(f),
  },
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
    // Verify the ref exists; if not, return HEAD (empty diff)
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

const findings = [];

for (const [file, lines] of addedLines) {
  for (const check of CHECKS) {
    if (!check.fileFilter(file)) continue;
    for (const { line, text } of lines) {
      if (!check.pattern.test(text)) continue;
      if (check.exclude && check.exclude.test(text)) continue;
      findings.push({
        category: check.category,
        severity: check.severity,
        message: check.message,
        file,
        line,
      });
    }
  }
}

const errorCount = findings.filter((f) => f.severity === 'error').length;
const warnCount  = findings.filter((f) => f.severity === 'warning').length;

const summary = findings.length === 0
  ? '✅ No security concerns found'
  : `🔒 ${findings.length} finding(s): ${errorCount} error(s), ${warnCount} warning(s)`;

console.log(JSON.stringify({ findings, summary }, null, 2));
process.exit(0);
