# Squad QA Test Plan

**Version tested:** 0.9.4-build.3  
**Platform:** Windows 11 / Node 24.12.0 / npm 11.6.2  
**Date:** 2026-05-03  
**Scope:** Source-build happy path, workstation tool security, CLI commands, test suite audit

---

## 1. Objectives

1. Verify a user can clone the repo, build from source, and use the CLI in a separate project.
2. Confirm Squad's operations stay confined to the user's project directory.
3. Validate the workstation tool security model (path confinement, env sanitisation, timeouts).
4. Identify broken or missing CLI commands.
5. Audit the existing test suite for coverage gaps and false negatives.

---

## 2. Test Scope

### In-Scope

| Area | Description |
|------|-------------|
| Build from source | `npm install` + `npm run build` produces a working CLI binary |
| CLI core commands | `init`, `doctor`, `status`, `roles`, `upgrade`, `export`/`import`, `nap` |
| Init isolation | `squad init` writes only to the current directory; squad source is untouched |
| Workstation tools | Path traversal, symlink attacks, env stripping, timeout clamping, write limits |
| Test suite | Run existing Vitest suite and catalogue failures |
| Doctor accuracy | False positives/negatives in `squad doctor` output |

### Out-of-Scope

| Area | Reason |
|------|--------|
| GitHub Copilot integration | Requires live Copilot subscription |
| Ralph watch mode (--execute) | Requires authenticated GitHub account with repos |
| MCP server integrations | Requires third-party setup |
| Personal squad | Optional ambient agent layer |
| Cloud / KEDA scheduler | Infrastructure dependency |

---

## 3. Test Cases

### TC-01 — Build from Source (Happy Path)

**Goal:** Verify a clean clone produces a working CLI.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | `git clone` the repo | Clone succeeds |
| 2 | `node --version` | Prints ≥22.5.0 |
| 3 | `npm install` | Installs without error |
| 4 | Verify workspace linking | `node_modules/@bradygaster/squad-sdk` is a symlink; `packages/squad-cli/node_modules/@bradygaster/squad-sdk` does NOT exist or is a symlink |
| 5 | `npm run build` | Both packages compile; `packages/squad-cli/dist/cli-entry.js` exists |
| 6 | `node packages/squad-cli/dist/cli-entry.js --version` | Prints version string |

**Known issue:** If a stale `packages/squad-cli/node_modules/@bradygaster/squad-sdk` directory exists (from a prior `npm install` against the published registry), step 5 will fail with TypeScript errors about missing exports. Workaround: `rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk` before building.

---

### TC-02 — Init in a User Project

**Goal:** Verify `squad init` creates the correct structure in the user's project and does not touch the Squad source repo.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | `mkdir my-project && cd my-project && git init` | Clean git repo |
| 2 | Run `node /path/to/squad/packages/squad-cli/dist/cli-entry.js init` | Prints "Squad initialized." |
| 3 | Verify `.squad/` created | `.squad/team.md`, `.squad/routing.md`, `.squad/decisions.md` all present |
| 4 | Verify `.github/agents/squad.agent.md` created | File present |
| 5 | Verify `.gitattributes` created | Contains `merge=union` entries |
| 6 | Check Squad source directory | Squad source `.squad/` unchanged |

---

### TC-03 — Doctor Accuracy

**Goal:** Verify `squad doctor` reports correctly.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Run `doctor` in the squad source repo | 11 checks pass; 0 failures |
| 2 | Run `doctor` in a freshly-initialised user project | Core checks pass; should NOT report "squad.js bundle — not found" |
| 3 | Delete `.squad/team.md`; run `doctor` | Failure reported for missing team.md |
| 4 | Create `.squad/casting/registry.json` with invalid JSON; run `doctor` | Failure reported for invalid JSON |

**Known issue (Bug):** `doctor` always fails the "squad.js bundle" check when run outside the Squad source repo because the check hardcodes `CWD/packages/squad-cli/dist/squad.js` as the bundle path.

---

### TC-04 — Workstation Tool: Path Traversal

**Goal:** Verify agents cannot escape the `rootDir` boundary.

| Step | Input Path | Expected Outcome |
|------|-----------|-----------------|
| 1 | `../../etc/passwd` | `EACCES` — path escapes rootDir |
| 2 | `/absolute/path/outside/root` | `EACCES` — absolute path outside rootDir |
| 3 | Symlink pointing outside rootDir | `EACCES` — symlink resolved, escapes rootDir |
| 4 | `../valid-subdir` that resolves within rootDir | Succeeds |
| 5 | `./normal-file.txt` | Succeeds |
| 6 | Non-existent but valid path | Path accepted, ENOENT returned for file not found |

---

### TC-05 — Workstation Tool: Environment Sanitisation

**Goal:** Verify sensitive env vars are stripped before shell commands.

| Step | Env Var Set | Command | Expected |
|------|-------------|---------|---------|
| 1 | `MY_API_KEY=secret` | `printenv MY_API_KEY` | Empty / not set |
| 2 | `ACCESS_TOKEN=abc` | `printenv ACCESS_TOKEN` | Empty / not set |
| 3 | `MY_PASSWORD=pw` | `printenv MY_PASSWORD` | Empty / not set |
| 4 | `NODE_OPTIONS=--require hack` | `printenv NODE_OPTIONS` | Empty / not set |
| 5 | `LD_PRELOAD=/evil.so` | `printenv LD_PRELOAD` | Empty / not set |
| 6 | `NORMAL_VAR=hello` | `printenv NORMAL_VAR` | `hello` — not stripped |

---

### TC-06 — Workstation Tool: Timeout Enforcement

**Goal:** Verify agent-supplied timeouts are clamped to host ceiling.

| Step | Host Ceiling | Agent Requests | Expected Actual Timeout |
|------|-------------|---------------|------------------------|
| 1 | 5000 ms | 999999 ms | 5000 ms (clamped) |
| 2 | 5000 ms | 0 ms | 5000 ms (zero → ceiling) |
| 3 | 5000 ms | -1 ms | 5000 ms (negative → ceiling) |
| 4 | 5000 ms | 2000 ms | 2000 ms (within ceiling) |
| 5 | 5000 ms | Not specified | 5000 ms (default to ceiling) |

---

### TC-07 — Workstation Tool: Write Limits

**Goal:** Verify the 10 MB write cap is enforced.

| Step | Content Size | Expected |
|------|-------------|---------|
| 1 | 9.9 MB | Write succeeds |
| 2 | 10 MB + 1 byte | `ETOOLARGE` error |
| 3 | Binary content (null bytes) | Read fails with `EBINARY` |

---

### TC-08 — Workstation Tool: Output Truncation

**Goal:** Verify stdout/stderr is capped at 100 KB.

| Step | Command | Expected |
|------|---------|---------|
| 1 | Outputs exactly 100 KB | Full output returned |
| 2 | Outputs 200 KB | Truncated at 100 KB with `[Output truncated]` notice |

---

### TC-09 — CLI Command Routing

**Goal:** Verify all documented commands are routable.

Commands to test: `init`, `upgrade`, `status`, `triage`/`watch`/`loop`, `copilot`, `doctor`, `link`, `externalize`, `internalize`, `shell`, `export`, `import`, `plugin`, `upstream`, `nap`, `aspire`, `scrub-emails`, `roles`, `cost`, `cast`, `personal`, `preset`, `auth`, `config`

Expected: Each command returns output (or a help message), NOT "unknown command."

---

### TC-10 — Init Idempotency

**Goal:** Verify running `squad init` twice does not corrupt existing state.

| Step | Action | Expected |
|------|--------|---------|
| 1 | `squad init` | Creates all files |
| 2 | Modify `.squad/team.md` — add a custom line | Custom line present |
| 3 | `squad init` again | Prints "Squad initialized." No error |
| 4 | Check `.squad/team.md` | Custom line preserved (init is non-destructive) |

---

### TC-11 — Export / Import Round-Trip

**Goal:** Verify squad state survives export/import.

| Step | Action | Expected |
|------|--------|---------|
| 1 | `squad init` | Creates state |
| 2 | `squad export > snapshot.json` | File written |
| 3 | Delete `.squad/` | State removed |
| 4 | `squad import snapshot.json` | State restored |
| 5 | `squad doctor` | Passes |

---

### TC-12 — Existing Test Suite

**Goal:** Run `npm test` and document pass/fail.

Expected baseline: All tests pass. Catalogue any failures for follow-up.

---

## 4. Test Environment

- Node.js ≥22.5.0 (tested on v24.12.0)
- npm ≥10.0.0 (tested on v11.6.2)
- Git installed and on PATH
- Windows 11 (bash via Git Bash / WSL)
- Gemini API key set as `GEMINI_API_KEY` (used by doctor check)
- NO active GitHub Copilot subscription required for most tests

---

## 5. Pass/Fail Criteria

| Category | Pass Criteria |
|----------|--------------|
| Build | `npm run build` exits 0; `cli-entry.js` exists |
| Init | `.squad/` created in CWD; squad source untouched |
| Security | All path traversal attempts blocked; sensitive env vars absent from child processes |
| Doctor | ≤0 false positives in a freshly-initialised project |
| Test suite | 0 failing tests |
| Commands | 0 "unknown command" responses for documented commands |
