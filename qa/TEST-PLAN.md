# Squad QA — Test Plan

**Version:** 0.9.4-build.6
**Date:** 2026-05-03
**Fork goals under test:**
1. Replatform off GitHub Copilot onto Google Gemini
2. Airgap — build from source, zero dependency on bradygaster npm binaries

---

## Scope

| In scope | Out of scope |
|----------|-------------|
| Build from source | Production deployment |
| squad init in a user project | squad triage --execute (requires external Copilot CLI) |
| squad doctor accuracy | squad start (deprecated PTY feature) |
| Gemini LLM wiring | Multi-agent live sessions (require Gemini quota) |
| Airgap compliance (static analysis) | squad aspire (requires Aspire runtime) |
| Unit/integration test suite | Cross-platform (Linux/Mac; Windows only in this run) |
| Package rename completeness | |
| Security model review | |

---

## Test Cases

### TC-01: Build from Source

**Goal:** Verify `npm run build` succeeds cleanly from a fresh clone.

**Steps:**
1. Clone `https://github.com/DeDuva/squad.git`
2. `npm install`
3. `npm run build`
4. `node packages/squad-cli/dist/cli-entry.js --version`

**Pass criteria:**
- Build exits 0
- Version string printed matches `package.json` version
- `packages/squad-sdk/dist/index.d.ts` exists
- `packages/squad-cli/dist/cli-entry.js` exists

---

### TC-02: Prebuild Idempotency

**Goal:** Verify that running `npm run build` twice in a row succeeds.

**Steps:**
1. Run `npm run build` (first run)
2. Run `npm run build` (second run, no manual cleaning)
3. Compare `--version` output

**Pass criteria:**
- Second build exits 0
- Version increments by 1 (prebuild bumps build number)
- No TypeScript declaration errors

---

### TC-03: squad init in a Fresh User Project

**Goal:** Verify `squad init` creates all required files in the target project.

**Steps:**
1. Create a temp directory outside the Squad source repo
2. `git init`
3. `node /path/to/squad/packages/squad-cli/dist/cli-entry.js init`

**Pass criteria:**
- Exit code 0
- `.squad/` directory with subdirs: `agents/`, `casting/`, `decisions/`, `identity/`, `log/`, `orchestration-log/`, `plugins/`, `skills/`, `templates/`
- `.squad/team.md` contains `## Members` header
- `.squad/routing.md` exists
- `.squad/config.json` is valid JSON
- `.github/agents/squad.agent.md` exists
- `.github/workflows/squad-*.yml` (4 files)
- `.gitattributes` contains `merge=union`

---

### TC-04: squad init Isolation

**Goal:** Verify `squad init` writes ONLY within the target project directory.

**Steps:**
1. Record parent directory contents before init
2. Run `squad init`
3. Verify parent directory is unchanged

**Pass criteria:**
- Parent directory contents identical before/after
- Squad source repo directory unmodified

---

### TC-05: squad init Idempotency

**Goal:** Verify `squad init` can be run multiple times without data corruption.

**Steps:**
1. Run `squad init`
2. Modify `.squad/team.md`
3. Run `squad init` again

**Pass criteria:**
- Second run exits 0
- Modified `team.md` content preserved
- No duplicate entries

---

### TC-06: squad doctor After Init (No Gemini Key)

**Goal:** Verify doctor accuracy immediately after init, without API key.

**Steps:**
1. Unset `GEMINI_API_KEY`
2. Run `squad doctor`

**Pass criteria:**
- All structural checks pass
- Gemini key check fails with actionable error
- `squad.js bundle` failure is the only other failure (known false positive)

---

### TC-07: squad doctor After Init (With Gemini Key)

**Goal:** Verify with API key, doctor reports exactly one failure (bundle).

**Steps:**
1. Set `GEMINI_API_KEY`
2. Run `squad doctor`

**Pass criteria:**
- 10 checks pass, 1 fails (bundle)
- Summary: "10 passed, 1 failed"

---

### TC-08: Gemini Replatforming — No Copilot SDK Dependency

**Goal:** Zero `@github/copilot-sdk` references in source.

**Steps:**
1. Search `packages/*/src/**/*.ts` for `@github/copilot-sdk` imports
2. Search all `package.json` for `@github/copilot-sdk` dependencies
3. Verify dist is clean after fresh `npm run build`

**Pass criteria:**
- Zero npm imports of `@github/copilot-sdk` anywhere in source or package.json

---

### TC-09: Gemini Client Wiring

**Goal:** Verify GeminiClient is the sole LLM runtime.

**Steps:**
1. Verify `adapter/client.ts` imports `GeminiClient`
2. Verify `gemini-client.ts` targets `generativelanguage.googleapis.com`
3. Verify all 6 models in catalog have `provider: 'google'`

**Pass criteria:**
- GeminiClient wired as sole backend
- SSE streaming implemented
- All models are Gemini family

---

### TC-10: Airgap Compliance — Package Namespace

**Goal:** Zero `@bradygaster/` npm package imports.

**Steps:**
1. Search all `package.json` for `@bradygaster/` in dependencies
2. Search all `.ts` source for `import.*@bradygaster/`
3. Verify `node_modules/@deduvafork/squad-sdk` is a symlink

**Pass criteria:**
- Zero `@bradygaster/` package dependencies
- `node_modules/@deduvafork/squad-sdk` is symlink to workspace

---

### TC-11: Airgap Compliance — Runtime bradygaster URLs

**Goal:** Identify any runtime-executed code that constructs URLs to bradygaster.

**Steps:**
1. Search source for `bradygaster` string
2. Categorize: attribution comment vs runtime-executed URL

**Pass criteria:**
- Zero runtime-executed feature URLs pointing to bradygaster/squad
- Comments/JSDoc attribution acceptable

---

### TC-12: Test Suite Baseline

**Goal:** Establish passing/failing baseline.

**Steps:**
1. Run `npm test`
2. Record summary line

**Pass criteria:**
- Total: 6,102 tests
- Failing: ≤86 (pre-existing baseline)
- No new failures from package rename

---

### TC-13: squad upgrade (Template Refresh)

**Goal:** Verify upgrade refreshes templates, preserves team state.

**Steps:**
1. Add a custom note to `.squad/team.md`
2. Run `squad upgrade`

**Pass criteria:**
- Custom `team.md` content preserved
- Workflow files refreshed
- `.squad/agents/` untouched

---

### TC-14: squad export / import Round-Trip

**Goal:** Verify squad state survives export→delete→import.

**Steps:**
1. `squad export > snapshot.json`
2. Delete `.squad/`
3. `squad import snapshot.json`
4. `squad doctor`

**Pass criteria:**
- Doctor shows same pass/fail pattern post-import

---

### TC-15: Workstation Tool — Path Traversal Blocking

**Goal:** Verify runtime path traversal protection.

**Steps:**
1. Run `test/workstation-tools.test.ts`

**Pass criteria:**
- `../../etc/passwd` blocked with EACCES
- Symlinks escaping rootDir blocked

---

## Test Environment

| Item | Value |
|------|-------|
| OS | Windows 11 Home 10.0.26200 |
| Node.js | v24.12.0 |
| npm | 11.x |
| Squad version | 0.9.4-build.6 |
| Shell | bash (Git Bash) |
| Gemini API key | Set via `GEMINI_API_KEY` |
