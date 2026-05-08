# Hook Governance — SDK Sample PRD

## Overview
Demonstrate Squad's governance engine. Rules don't live in prompts — they live in code. This sample shows file-write guards, PII scrubbing, reviewer lockout, and ask-user rate limiting in action. Each hook fires deterministically, blocking unauthorized actions before tools execute.

## Target Audience
Architects and leads who need governance proof-of-concept. DevOps teams implementing squad automation with security guardrails. This answers: "How do I prevent agents from writing files they shouldn't?"

## SDK APIs Demonstrated

| API | Module | What It Shows |
|-----|--------|--------------|
| `HookPipeline` | `hooks` | Central governance engine; manages pre/post-tool hooks |
| `PolicyConfig` | `hooks` | Typed configuration for file guards, blocked commands, rate limits |
| `ReviewerLockoutHook` | `hooks` | Agent lockout from artifacts after review rejection |
| File-write guard | `hooks/index.ts` (lines 152–182) | Glob-pattern matching for allowed write paths |
| PII scrubber | `hooks/index.ts` (lines 243–266) | Regex-based email redaction in tool output |
| Ask-user rate limiter | `hooks/index.ts` (lines 216–241) | Per-session call count enforcement |
| Shell command restriction | `hooks/index.ts` (lines 184–214) | Block destructive git/system commands |

## Code Highlights

**Initialize HookPipeline with policy:**
```typescript
import { HookPipeline, ReviewerLockoutHook } from '@deduvafork/squad-sdk';

const pipeline = new HookPipeline({
  allowedWritePaths: ['src/**/*.ts', 'docs/**', '.squad/**'],
  blockedCommands: ['rm -rf', 'git push --force', 'git reset --hard'],
  maxAskUserPerSession: 3,
  scrubPii: true,
  reviewerLockout: true,
});
```

**Pre-tool hook fire — file-write guard blocks unauthorized path:**
```typescript
// Hook runs before tool executes
const result = await pipeline.runPreToolHooks({
  toolName: 'edit',
  agentName: 'Backend',
  sessionId: 'sess-001',
  arguments: { path: '/etc/passwd', content: 'evil' },
});

// Result: 
// {
//   action: 'block',
//   reason: "File write blocked: '/etc/passwd' does not match allowed paths. Allowed patterns: src/**/*.ts, docs/**, .squad/**"
// }
```

**PII scrubber — email redaction in post-tool output:**
```typescript
// Agent logs: "Contact brady@example.com about deployment"
const output = { message: 'Contact brady@example.com about deployment' };

const scrubbed = await pipeline.runPostToolHooks({
  toolName: 'log_event',
  agentName: 'DevOps',
  sessionId: 'sess-001',
  arguments: {},
  result: output,
});

// Result:
// { result: { message: 'Contact [EMAIL_REDACTED] about deployment' } }
```

**Reviewer lockout — prevent re-edits after rejection:**
```typescript
const lockout = pipeline.getReviewerLockout();

// Reviewer rejects Backend's auth.ts changes
lockout.lockout('src/auth.ts', 'Backend');

// Later, Backend tries to re-edit
const blockResult = await pipeline.runPreToolHooks({
  toolName: 'edit',
  agentName: 'Backend',
  sessionId: 'sess-001',
  arguments: { path: 'src/auth.ts', content: '...' },
});

// Result: 
// {
//   action: 'block',
//   reason: 'Reviewer lockout: Agent "Backend" is locked out of artifact "src/auth.ts". Another reviewer must handle this artifact.'
// }
```

**Ask-user rate limiter — stop prompt spam:**
```typescript
// Pipeline blocks 4th ask_user call
const context = {
  toolName: 'ask_user',
  agentName: 'Frontend',
  sessionId: 'sess-001',
  arguments: { question: 'What color?' },
};

// After 3 calls...
const result = await pipeline.runPreToolHooks(context);

// Result (4th attempt):
// {
//   action: 'block',
//   reason: 'ask_user rate limit exceeded: 3/3 calls used for this session. The agent should proceed without user input.'
// }
```

## User Experience

1. User configures policies in `squad.yaml`
2. SDK initializes HookPipeline with those policies
3. User triggers agent work (editing files, running commands, logging data)
4. Each tool call hits pre-tool hooks first → blocked if violates policy
5. Tool output hits post-tool hooks → PII scrubbed
6. Terminal shows each hook decision:
   ```
   ✅ File edit allowed: src/auth.ts (matches allowed path src/**/*.ts)
   ❌ File edit blocked: /etc/passwd (does not match allowed paths)
   ⚠️  PII scrubbed: Email redacted in tool output
   🔒 Agent locked out: Backend cannot edit src/auth.ts (reviewer lockout)
   🛑 Rate limit exceeded: ask_user (3/3 calls used)
   ```

## Acceptance Criteria

1. ✅ File-write guard blocks files outside allowed paths
2. ✅ File-write guard allows files matching glob patterns
3. ✅ PII scrubber detects and redacts email addresses in tool output
4. ✅ Shell command restriction blocks dangerous git/system commands
5. ✅ Ask-user rate limiter enforces per-session call limit
6. ✅ Reviewer lockout blocks agent re-edits after lockout
7. ✅ Each hook decision is logged with reason
8. ✅ Sample is ~200 lines (excluding dependencies)

## Test Script

```bash
# Navigate to samples/hook-governance
npm install

# Run test suite
npm run test

# Expected output shows:
# PASS: File-write guard blocks /etc/passwd
# PASS: File-write guard allows src/auth.ts
# PASS: PII scrubber redacts emails
# PASS: Shell command blocker prevents rm -rf
# PASS: Ask-user rate limiter enforces 3-call limit
# PASS: Reviewer lockout blocks re-edits

# Run interactive demo
npm start

# User sees each hook fire and block in real-time
```
