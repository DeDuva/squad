# Squad QA — Recommendations

**Version:** 0.9.4-build.6
**Date:** 2026-05-03

---

## P0 — Blockers (must fix before stable release)

None. The build succeeds and the core happy path works.

---

## P1 — High Priority

### P1-01: Fix squad.js bundle false positive in doctor

**Symptom:** `squad doctor` always reports `❌ squad.js bundle — not found` in user projects, even when Squad is fully functional.

**Root cause:** `packages/squad-cli/src/cli/commands/doctor.ts` checks for the existence of `packages/squad-cli/dist/squad.js` relative to the Squad source root. In user projects, there is no `packages/squad-cli/dist/squad.js` — that path only exists inside the Squad source repo itself.

**Fix:** Gate the bundle check on whether the current process is running inside a Squad source checkout. One approach:

```typescript
// In doctor.ts
const isSrcCheckout = existsSync(join(cliDir, '../../packages/squad-cli/package.json'));
if (isSrcCheckout) {
  // run bundle check
} else {
  checks.push({ name: 'squad.js bundle', status: 'pass', detail: 'skipped (user project)' });
}
```

**Impact:** Every user running `squad doctor` sees a confusing failure that makes them think something is broken.

---

### P1-02: Update test suite for Gemini model catalog

**Symptom:** 86 pre-existing test failures. The dominant categories are:
- `resolveModel` tests asserting Claude/GPT model IDs as defaults
- `ECONOMY_MODEL_MAP` tests referencing `haiku`, `gpt-4.1`
- Cost estimation tests using Claude pricing
- CompatV041 tests referencing Claude/GPT model names

**Root cause:** The model catalog was replatformed to Gemini (`packages/squad-sdk/src/config/models.ts`), but the test files that assert expected model IDs were not updated.

**Fix:** Update test expectations throughout the following files:
- `test/models.test.ts`
- `test/model-preference.test.ts`
- `test/model-fallback.test.ts`
- `test/cost-tracking.test.ts`
- `test/compat-v041.test.ts`
- Any test asserting `claude-haiku-4.5`, `claude-sonnet-4.6`, `gpt-4.1` as a Squad default

**Example fix pattern:**
```typescript
// Before
expect(resolved).toBe('claude-haiku-4.5');
// After
expect(resolved).toBe('gemini-2.5-flash-preview-04-17'); // Squad default
```

---

### P1-03: Update SkillSource tests for `.squad/skills/` directory

**Symptom:** `LocalSkillSource` tests fail because they expect skills to be in `.copilot/skills/`.

**Root cause:** Squad moved the skills directory from `.copilot/skills/` to `.squad/skills/`, but `test/skill-source.test.ts` still constructs test fixtures in the old path.

**Fix:**
```typescript
// Before
const skillsDir = join(tmpDir, '.copilot', 'skills');
// After
const skillsDir = join(tmpDir, '.squad', 'skills');
```

---

## P2 — Medium Priority

### P2-01: Fix squad triage --execute default runner

**Symptom:** `squad triage --execute` defaults `agentCmd` to `copilot`. Users without GitHub Copilot CLI installed get `command not found`.

**Location:** `packages/squad-cli/src/cli/commands/watch/capabilities/execute.ts:63`

**Fix options:**
1. Change the default to a help message that explains `--agent-cmd` is required:
   ```typescript
   const agentCmd = opts.agentCmd ?? (() => { throw new Error(
     'squad triage --execute requires --agent-cmd. Example: --agent-cmd "gh copilot"'
   ) })();
   ```
2. Document the `--agent-cmd` flag prominently in `squad triage --help` output.

---

### P2-02: Fix runtime URLs pointing to bradygaster/squad

**Files and locations:**

1. `packages/squad-cli/src/cli/core/init.ts:91` — Error message URL:
   ```typescript
   // Before
   `https://github.com/bradygaster/squad/issues/101`
   // After
   `https://github.com/DeDuva/squad/issues`
   ```

2. `packages/squad-cli/src/cli/upgrade.ts:213` — Release URL in self-upgrade:
   ```typescript
   // Before
   releaseUrl: `https://github.com/bradygaster/squad/releases/tag/v${latest}`
   // After
   releaseUrl: `https://github.com/DeDuva/squad/releases/tag/v${latest}`
   ```

**Impact:** Users following error message links land on the wrong repo. The self-upgrade feature checks the wrong release page.

---

### P2-03: Fix npm-package.ts build metadata

**Location:** `packages/squad-sdk/src/build/npm-package.ts:97`

```typescript
// Before
repository: { type: 'git', url: 'https://github.com/bradygaster/squad.git' }
// After
repository: { type: 'git', url: 'https://github.com/DeDuva/squad.git' }
```

**Impact:** Any `npm pack` artifact would contain the wrong repository URL in its package metadata.

---

### P2-04: Fix squad init success message "Copilot agent prompt"

**Symptom:** During init, the success banner reads `🤖  Copilot agent prompt` for the `squad.agent.md` file.

**Location:** `packages/squad-cli/src/cli/core/init.ts` — wherever the success summary is printed.

**Fix:** Change to `🤖  Agent coordinator prompt` or `🤖  squad.agent.md`.

**Impact:** Cosmetic, but confusing for a fork that's replatforming away from Copilot.

---

### P2-05: squad start is deprecated but not clearly marked

**Symptom:** `squad start` still works but uses hardcoded Windows Copilot binary paths. On non-Windows systems or without GitHub Copilot CLI installed, it fails non-obviously.

**Location:** `packages/squad-cli/src/cli/commands/start.ts:154-159`

**Fix:** Add a deprecation warning at the top of the command that runs before any execution:
```typescript
console.warn('⚠️  squad start is deprecated. Use your AI coding agent directly with squad.agent.md.');
process.exit(1); // or return
```

---

## P3 — Low Priority / Cleanup

### P3-01: squad.agent.md model references (cosmetic)

The coordinator template references `claude-sonnet-4.6`, `claude-haiku-4.5`, `gemini-3-pro-preview` as example models for spawned agents. These are valid (Squad supports multi-model) but `gemini-3-pro-preview` doesn't exist in the current catalog. Update to use real model IDs from the catalog.

### P3-02: Add squad triage --execute documentation to README

The README doesn't clearly explain that `squad triage --execute` requires an external agent CLI runner and that the default (`copilot`) will fail if not installed.

### P3-03: Clarify squad.agent.md multi-model nature

The README should explain that while the Squad runtime uses Gemini, agents spawned by the coordinator can use any model — Claude, GPT, or Gemini — depending on what the user's coding agent has access to.

### P3-04: remove references to `bradygaster/squad-sdk` in package.json URLs

`packages/squad-cli/package.json` and `packages/squad-sdk/package.json` still have `homepage`, `bugs.url`, and `repository.url` pointing to `bradygaster/squad`. Update to `DeDuva/squad`.

---

## Summary Table

| ID | Description | Severity | Effort |
|----|-------------|----------|--------|
| P1-01 | doctor bundle false positive | High | Small (1 file, ~10 lines) |
| P1-02 | Test suite model catalog update | High | Medium (10+ test files) |
| P1-03 | SkillSource test directory fix | High | Small (1–2 test files) |
| P2-01 | triage --execute default runner | Medium | Small (1 file) |
| P2-02 | Runtime URLs → DeDuva/squad | Medium | Small (2 files, 2 lines) |
| P2-03 | npm-package.ts repo URL | Medium | Trivial |
| P2-04 | Init "Copilot agent prompt" label | Medium | Trivial |
| P2-05 | squad start deprecation | Medium | Small |
| P3-01 | squad.agent.md model IDs | Low | Trivial |
| P3-02 | Docs: triage --execute runner | Low | Trivial |
| P3-03 | Docs: multi-model clarification | Low | Trivial |
| P3-04 | package.json homepage/bugs URLs | Low | Trivial |
