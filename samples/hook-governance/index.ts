/**
 * hook-governance — Beginner sample for @squad/sdk Hook Pipeline
 *
 * Demonstrates the four governance hooks:
 *  1. File-Write Guards    — block writes outside safe zones
 *  2. PII Scrubbing        — redact emails from tool output
 *  3. Reviewer Lockout     — prevent locked-out agents from editing artifacts
 *  4. Ask-User Rate Limit  — cap how many times an agent can prompt the user
 */

import {
  HookPipeline,
  ReviewerLockoutHook,
} from '@squad/sdk/hooks';
import type {
  PreToolUseContext,
  PostToolUseContext,
} from '@squad/sdk/hooks';

// ── Helpers ──────────────────────────────────────────────────────────

function hr(label: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

function showResult(label: string, value: string): void {
  console.log(`  ${label}: ${value}`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🛡️  hook-governance — Squad SDK governance hooks sample\n');

  // ── Demo 1: File-Write Guards ────────────────────────────────────
  hr('Demo 1 — File-Write Guards');
  console.log('  Only writes to src/**/*.ts and .squad/** are allowed.\n');

  const guardPipeline = new HookPipeline({
    allowedWritePaths: ['src/**/*.ts', '.squad/**'],
  });

  // Allowed write
  const allowedCtx: PreToolUseContext = {
    toolName: 'create',
    arguments: { path: 'src/utils/helper.ts' },
    agentName: 'McManus',
    sessionId: 'session-001',
  };

  const allowedResult = await guardPipeline.runPreToolHooks(allowedCtx);
  showResult('Write to src/utils/helper.ts', `${allowedResult.action} ✅`);

  // Blocked write
  const blockedCtx: PreToolUseContext = {
    toolName: 'edit',
    arguments: { path: '/etc/passwd' },
    agentName: 'McManus',
    sessionId: 'session-001',
  };

  const blockedResult = await guardPipeline.runPreToolHooks(blockedCtx);
  showResult('Write to /etc/passwd', `${blockedResult.action} 🚫`);
  if (blockedResult.reason) {
    console.log(`  Reason: ${blockedResult.reason}`);
  }

  // ── Demo 2: PII Scrubbing ───────────────────────────────────────
  hr('Demo 2 — PII Scrubbing');
  console.log('  Emails in tool output are automatically redacted.\n');

  const piiPipeline = new HookPipeline({ scrubPii: true });

  const piiCtx: PostToolUseContext = {
    toolName: 'bash',
    arguments: { command: 'git log --oneline' },
    result: 'Deploy fix by brady@example.com — cc: alice@company.io, bob@test.org',
    agentName: 'Verbal',
    sessionId: 'session-002',
  };

  console.log(`  Before: ${piiCtx.result}`);
  const piiResult = await piiPipeline.runPostToolHooks(piiCtx);
  console.log(`  After:  ${piiResult.result}`);

  // Object scrubbing
  const objCtx: PostToolUseContext = {
    toolName: 'read_file',
    arguments: { path: 'contacts.json' },
    result: { name: 'Brady', email: 'brady@example.com', notes: 'reach out to alice@company.io' },
    agentName: 'Verbal',
    sessionId: 'session-002',
  };

  console.log(`\n  Object before: ${JSON.stringify(objCtx.result)}`);
  const objResult = await piiPipeline.runPostToolHooks(objCtx);
  console.log(`  Object after:  ${JSON.stringify(objResult.result)}`);

  // ── Demo 3: Reviewer Lockout ────────────────────────────────────
  hr('Demo 3 — Reviewer Lockout');
  console.log('  Once a reviewer rejects, the original author is locked out.\n');

  const lockoutPipeline = new HookPipeline({ reviewerLockout: true });
  const lockout = lockoutPipeline.getReviewerLockout();

  // Lock Backend out of src/auth.ts
  lockout.lockout('src/auth.ts', 'Backend');
  showResult('Locked out', 'Backend from src/auth.ts');
  showResult('isLockedOut("src/auth.ts", "Backend")', String(lockout.isLockedOut('src/auth.ts', 'Backend')));

  // Backend tries to edit src/auth.ts — blocked
  const lockoutCtx: PreToolUseContext = {
    toolName: 'edit',
    arguments: { path: 'src/auth.ts' },
    agentName: 'Backend',
    sessionId: 'session-003',
  };

  const lockoutResult = await lockoutPipeline.runPreToolHooks(lockoutCtx);
  showResult('Backend edits src/auth.ts', `${lockoutResult.action} 🚫`);
  if (lockoutResult.reason) {
    console.log(`  Reason: ${lockoutResult.reason}`);
  }

  // Frontend (not locked out) can still edit
  const frontendCtx: PreToolUseContext = {
    ...lockoutCtx,
    agentName: 'Frontend',
  };

  const frontendResult = await lockoutPipeline.runPreToolHooks(frontendCtx);
  showResult('Frontend edits src/auth.ts', `${frontendResult.action} ✅`);

  // Show lockout registry
  showResult('Locked agents for src/auth.ts', lockout.getLockedAgents('src/auth.ts').join(', '));

  // ── Demo 4: Ask-User Rate Limiter ───────────────────────────────
  hr('Demo 4 — Ask-User Rate Limiter');
  console.log('  Agents can ask the user at most 3 times per session.\n');

  const ratePipeline = new HookPipeline({ maxAskUserPerSession: 3 });

  for (let i = 1; i <= 5; i++) {
    const askCtx: PreToolUseContext = {
      toolName: 'ask_user',
      arguments: { question: `Clarification #${i}?` },
      agentName: 'Fenster',
      sessionId: 'session-004',
    };

    const askResult = await ratePipeline.runPreToolHooks(askCtx);
    const emoji = askResult.action === 'allow' ? '✅' : '🚫';
    showResult(`  Ask #${i}`, `${askResult.action} ${emoji}`);
    if (askResult.reason) {
      console.log(`    Reason: ${askResult.reason}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  hr('Summary');
  console.log('  All four governance hooks demonstrated:');
  console.log('    ✅ File-write guards block unsafe paths');
  console.log('    ✅ PII scrubbing redacts emails automatically');
  console.log('    ✅ Reviewer lockout enforces review decisions');
  console.log('    ✅ Rate limiting caps user interruptions');
  console.log('\n  Rules run as code, not prompts. No interpretation. No ambiguity. 🛡️\n');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
