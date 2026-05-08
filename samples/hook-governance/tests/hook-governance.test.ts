/**
 * hook-governance acceptance tests
 *
 * Validates the four governance hooks demonstrated in the sample.
 */

import { describe, it, expect } from 'vitest';
import {
  HookPipeline,
  ReviewerLockoutHook,
} from '@deduvafork/squad-sdk/hooks';
import type {
  PreToolUseContext,
  PostToolUseContext,
} from '@deduvafork/squad-sdk/hooks';

// ── Helpers ──────────────────────────────────────────────────────────

function makePreCtx(overrides: Partial<PreToolUseContext> = {}): PreToolUseContext {
  return {
    toolName: 'edit',
    arguments: { path: 'src/main.ts' },
    agentName: 'TestAgent',
    sessionId: 'test-session',
    ...overrides,
  };
}

function makePostCtx(overrides: Partial<PostToolUseContext> = {}): PostToolUseContext {
  return {
    toolName: 'bash',
    arguments: {},
    result: 'some output',
    agentName: 'TestAgent',
    sessionId: 'test-session',
    ...overrides,
  };
}

// ── File-Write Guards ────────────────────────────────────────────────

describe('File-Write Guards', () => {
  const pipeline = new HookPipeline({
    allowedWritePaths: ['src/**/*.ts', '.squad/**'],
  });

  it('allows writes to permitted paths', async () => {
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'create', arguments: { path: 'src/utils/helper.ts' } }),
    );
    expect(result.action).toBe('allow');
  });

  it('blocks writes to /etc/passwd', async () => {
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'edit', arguments: { path: '/etc/passwd' } }),
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('/etc/passwd');
  });

  it('blocks writes to random directories', async () => {
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'write_file', arguments: { path: '/tmp/evil.sh' } }),
    );
    expect(result.action).toBe('block');
  });

  it('allows writes to .squad/ directory', async () => {
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'create', arguments: { path: '.squad/agents/test/charter.md' } }),
    );
    expect(result.action).toBe('allow');
  });

  it('ignores non-write tools', async () => {
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'read_file', arguments: { path: '/etc/passwd' } }),
    );
    expect(result.action).toBe('allow');
  });
});

// ── PII Scrubbing ────────────────────────────────────────────────────

describe('PII Scrubbing', () => {
  const pipeline = new HookPipeline({ scrubPii: true });

  it('redacts email addresses from string output', async () => {
    const result = await pipeline.runPostToolHooks(
      makePostCtx({ result: 'contact brady@example.com about deploy' }),
    );
    expect(result.result).toBe('contact [EMAIL_REDACTED] about deploy');
  });

  it('redacts multiple emails', async () => {
    const result = await pipeline.runPostToolHooks(
      makePostCtx({ result: 'cc: a@b.com and c@d.org' }),
    );
    expect(result.result).toBe('cc: [EMAIL_REDACTED] and [EMAIL_REDACTED]');
  });

  it('passes through text without emails unchanged', async () => {
    const result = await pipeline.runPostToolHooks(
      makePostCtx({ result: 'no sensitive data here' }),
    );
    expect(result.result).toBe('no sensitive data here');
  });

  it('scrubs emails in nested objects', async () => {
    const input = { user: { email: 'test@example.com', name: 'Test' } };
    const result = await pipeline.runPostToolHooks(
      makePostCtx({ result: input }),
    );
    const scrubbed = result.result as any;
    expect(scrubbed.user.email).toBe('[EMAIL_REDACTED]');
    expect(scrubbed.user.name).toBe('Test');
  });

  it('scrubs emails in arrays', async () => {
    const result = await pipeline.runPostToolHooks(
      makePostCtx({ result: ['a@b.com', 'no-email', 'c@d.org'] }),
    );
    expect(result.result).toEqual(['[EMAIL_REDACTED]', 'no-email', '[EMAIL_REDACTED]']);
  });
});

// ── Reviewer Lockout ─────────────────────────────────────────────────

describe('Reviewer Lockout', () => {
  it('blocks locked-out agent from editing artifact', async () => {
    const pipeline = new HookPipeline({ reviewerLockout: true });
    const lockout = pipeline.getReviewerLockout();

    lockout.lockout('src/auth.ts', 'Backend');

    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'edit', arguments: { path: 'src/auth.ts' }, agentName: 'Backend' }),
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('Backend');
    expect(result.reason).toContain('src/auth.ts');
  });

  it('allows non-locked-out agents to edit', async () => {
    const pipeline = new HookPipeline({ reviewerLockout: true });
    const lockout = pipeline.getReviewerLockout();

    lockout.lockout('src/auth.ts', 'Backend');

    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'edit', arguments: { path: 'src/auth.ts' }, agentName: 'Frontend' }),
    );
    expect(result.action).toBe('allow');
  });

  it('lockout can be cleared', async () => {
    const lockout = new ReviewerLockoutHook();
    lockout.lockout('file.ts', 'Agent1');
    expect(lockout.isLockedOut('file.ts', 'Agent1')).toBe(true);

    lockout.clearLockout('file.ts');
    expect(lockout.isLockedOut('file.ts', 'Agent1')).toBe(false);
  });

  it('lists locked agents for an artifact', () => {
    const lockout = new ReviewerLockoutHook();
    lockout.lockout('file.ts', 'Agent1');
    lockout.lockout('file.ts', 'Agent2');
    expect(lockout.getLockedAgents('file.ts')).toEqual(expect.arrayContaining(['Agent1', 'Agent2']));
  });

  it('clearAll removes all lockouts', () => {
    const lockout = new ReviewerLockoutHook();
    lockout.lockout('a.ts', 'X');
    lockout.lockout('b.ts', 'Y');
    lockout.clearAll();
    expect(lockout.isLockedOut('a.ts', 'X')).toBe(false);
    expect(lockout.isLockedOut('b.ts', 'Y')).toBe(false);
  });
});

// ── Ask-User Rate Limiter ────────────────────────────────────────────

describe('Ask-User Rate Limiter', () => {
  it('allows up to the limit, then blocks', async () => {
    const pipeline = new HookPipeline({ maxAskUserPerSession: 3 });

    for (let i = 0; i < 3; i++) {
      const result = await pipeline.runPreToolHooks(
        makePreCtx({ toolName: 'ask_user', sessionId: 'rate-test' }),
      );
      expect(result.action).toBe('allow');
    }

    // 4th call should be blocked
    const blocked = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'ask_user', sessionId: 'rate-test' }),
    );
    expect(blocked.action).toBe('block');
    expect(blocked.reason).toContain('rate limit');
  });

  it('tracks sessions independently', async () => {
    const pipeline = new HookPipeline({ maxAskUserPerSession: 1 });

    const r1 = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'ask_user', sessionId: 'session-a' }),
    );
    expect(r1.action).toBe('allow');

    const r2 = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'ask_user', sessionId: 'session-b' }),
    );
    expect(r2.action).toBe('allow');

    // session-a is now at limit
    const r3 = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'ask_user', sessionId: 'session-a' }),
    );
    expect(r3.action).toBe('block');
  });

  it('does not limit non-ask_user tools', async () => {
    const pipeline = new HookPipeline({ maxAskUserPerSession: 1 });

    // Use up the ask_user limit
    await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'ask_user', sessionId: 'tool-test' }),
    );

    // Other tools should still work
    const result = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'edit', sessionId: 'tool-test' }),
    );
    expect(result.action).toBe('allow');
  });
});

// ── Combined Pipeline ────────────────────────────────────────────────

describe('Combined Pipeline', () => {
  it('enforces multiple policies simultaneously', async () => {
    const pipeline = new HookPipeline({
      allowedWritePaths: ['src/**/*.ts'],
      scrubPii: true,
      reviewerLockout: true,
      maxAskUserPerSession: 2,
    });

    // File guard blocks
    const writeBlocked = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'create', arguments: { path: '/etc/shadow' } }),
    );
    expect(writeBlocked.action).toBe('block');

    // PII scrubbed
    const scrubbed = await pipeline.runPostToolHooks(
      makePostCtx({ result: 'user: admin@corp.com' }),
    );
    expect(scrubbed.result).toBe('user: [EMAIL_REDACTED]');

    // Allowed write works (needs subdirectory for src/**/*.ts glob)
    const writeAllowed = await pipeline.runPreToolHooks(
      makePreCtx({ toolName: 'edit', arguments: { path: 'src/utils/index.ts' } }),
    );
    expect(writeAllowed.action).toBe('allow');
  });
});
