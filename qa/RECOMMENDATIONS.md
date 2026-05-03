# Squad QA Recommendations

**Version:** 0.9.4-build.3  
**Date:** 2026-05-03

---

## Priority Ranking

| Priority | Issue | Impact |
|----------|-------|--------|
| P0 | Stale nested dependency breaks first build | Blocks every new contributor |
| P0 | Doctor false positive in user projects | Erodes trust; confuses every user |
| P1 | `copilot` / `copilot-bridge` commands missing | Tests fail; README references commands that don't work |
| P1 | 86 failing tests | CI is unreliable; changes may silently regress features |
| P2 | Model catalog test coupling | Tests will break on every model update |
| P2 | Casting engine overflow (usual-suspects universe) | Runtime crash when universe too small for team |
| P3 | SQUAD_TEAM_ROOT null-return contract | Edge-case crash for users with misconfigured env |
| P3 | Windows process kill (taskkill not attempted in some paths) | Timeout enforcement weaker on Windows |

---

## P0 — Fix the Stale Nested Dependency

**Problem:** `packages/squad-cli/node_modules/@bradygaster/squad-sdk/` is a real directory installed from the npm registry. npm workspaces should symlink it from the root `node_modules`, but an earlier `npm install` (or CI run) left a physical copy there. TypeScript resolves the nested copy first, finding an older version that doesn't export `resolvePresetsDir`, `ensureSquadHome`, or `resolveSquadHome`.

**Fix (code):**

Add a `postinstall` hook to the root `package.json` to clean the stale path:

```json
"scripts": {
  "postinstall": "node -e \"require('fs').rmSync('packages/squad-cli/node_modules/@bradygaster/squad-sdk', {recursive:true,force:true})\""
}
```

Or add to `.npmrc`:

```
workspaces-update=false
```

Or document in CONTRIBUTING.md and add a pre-build script that checks for and removes the stale directory:

```bash
# scripts/clean-stale-workspace.mjs
import { rmSync } from 'node:fs';
rmSync('packages/squad-cli/node_modules/@bradygaster/squad-sdk', { recursive: true, force: true });
```

And reference it from `prebuild`:

```json
"prebuild": "node scripts/clean-stale-workspace.mjs && node scripts/bump-build.mjs && ..."
```

---

## P0 — Fix the Doctor Bundle Check

**Problem:** `squad doctor` checks for `CWD/packages/squad-cli/dist/squad.js`. This path only exists inside the Squad monorepo. Every user running `doctor` in their own project sees a false failure.

**Fix:**

The check should detect whether it is running inside the Squad source repo before performing the bundle check. A simple heuristic is checking for `packages/squad-cli/package.json`:

```typescript
// In doctor.ts, around line 344
const inSquadRepo = fs.existsSync(path.join(cwd, 'packages', 'squad-cli', 'package.json'));
if (inSquadRepo) {
  const bundlePath = path.join(cwd, 'packages', 'squad-cli', 'dist', 'squad.js');
  checks.push(fs.existsSync(bundlePath)
    ? { name: 'squad.js bundle', status: 'pass', message: bundlePath }
    : { name: 'squad.js bundle', status: 'fail', message: 'not found — run: npm run build' }
  );
}
// else: skip the check entirely — user is not in the Squad source repo
```

This eliminates the false positive for all end users while keeping the check useful for contributors.

---

## P1 — Implement or Remove `copilot` and `copilot-bridge` Commands

**Problem:** The test suite (`test/cli-packaging-smoke.test.ts`) asserts that `squad copilot` and `squad copilot-bridge` are routable commands. Neither exists in `cli-entry.ts`. The tests fail and the CLI returns "unknown command."

**Recommendation A (implement):** Add the commands. The existing `squad copilot` command is documented in the README ("Add/remove the Copilot coding agent"). If this feature is not yet implemented, add a stub that prints "coming soon" or redirects to docs.

**Recommendation B (remove from tests):** If these commands are intentionally deferred, mark the tests as `todo` with a tracking issue rather than leaving them as failing assertions.

---

## P1 — Resolve Test Suite Failures (86 failing tests)

### 1. Decouple model catalog tests from hardcoded model IDs

Tests that assert specific model IDs exist in the catalog are brittle. The catalog is expected to evolve as model families are updated. Refactor tests to check structural properties instead:

```typescript
// Instead of:
expect(MODEL_CATALOG).toContain('claude-opus-4.5');

// Use:
const premiumModels = MODEL_CATALOG.filter(m => m.tier === 'premium');
expect(premiumModels.length).toBeGreaterThan(0);
expect(premiumModels[0].provider).toBe('anthropic');
```

### 2. Fix casting engine overflow for small universes

The `usual-suspects` universe cannot fill all required roles including "scribe." The casting algorithm should either:
- Fall back to the next universe if the selected one can't fill all roles
- Reserve a slot for Scribe before beginning cast name allocation (Scribe is always "Scribe" and doesn't need a cast name — the issue may be the algorithm incorrectly trying to allocate one)

Review `CastingEngine` source — the Scribe exemption in `squad.agent.md` ("Scribe is always 'Scribe' — exempt from casting") must be implemented in the engine itself.

### 3. Fix SQUAD_TEAM_ROOT null-return contract

When `SQUAD_TEAM_ROOT` is set but points to a non-existent path, `resolveSquad()` should return `null`. Verify the implementation against the test expectation and fix.

### 4. Fix MessageStream horizontal rule

The test expects a horizontal rule (`---`) between conversation turns. Check whether this was intentionally removed and either restore it or update the test to reflect the new behavior.

### 5. Fix Scheduler LocalPollingProvider script execution

The `executeScriptTask` path returns `false` when the test expects `true`. Trace the execution path and fix either the implementation or the test expectation.

---

## P2 — Improve Casting Engine Resilience

The casting engine currently crashes with an unhandled error when a universe doesn't have enough characters. This should be a graceful failure with a clear user-facing message and automatic fallback:

```
[cast] Warning: universe "usual-suspects" has insufficient characters.
       Falling back to "ocean's-eleven" universe.
```

---

## P2 — npm link Workflow Documentation

**Problem:** The CONTRIBUTING.md mentions `npm run dev:link` for local linking but doesn't warn about the stale node_modules issue. New contributors will hit the build failure without any guidance.

**Recommendation:** Add a "Common Issues" section to CONTRIBUTING.md:

```markdown
## Common Issues

### Build fails with "Property 'resolvePresetsDir' does not exist"

A stale copy of `@bradygaster/squad-sdk` exists in the nested node_modules.
Remove it before building:

    rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk
    npm run build
```

---

## P3 — Windows Process Kill Improvement

The current implementation on Windows only calls `taskkill /F /T` via a fire-and-forget `spawn`. If `child.pid` is unavailable (race condition), the fallback `child.kill('SIGKILL')` is used, which on Windows only kills the direct child, not any background processes it spawned.

**Recommendation:** In `workstation.ts`, the `runCommand` function should await the `taskkill` spawn to confirm it ran, or use `execSync('taskkill ...')` for synchronous kill on timeout.

---

## P3 — SQUAD_NO_PERSONAL Environment Variable

The `SQUAD_NO_PERSONAL` kill switch for personal squad is documented in `squad.agent.md` but does not appear to be checked in the CLI entry point or SDK. Verify the implementation matches the documented behavior.

---

## General Recommendations

### 1. Pin the Node.js version

`package.json` specifies `"node": ">=22.5.0"` for `node:sqlite` support. Add an `.nvmrc` or `.node-version` file with the exact version used in CI to prevent "works on my machine" issues.

### 2. Add a `build:clean` script

```json
"build:clean": "npm run build:clean-stale && npm run build"
"build:clean-stale": "node -e \"require('fs').rmSync('packages/squad-cli/node_modules/@bradygaster/squad-sdk', {recursive:true,force:true})\""
```

### 3. Harden `workstation_bash` on Windows

The current code uses `cmd.exe` as the default shell on Windows. `cmd.exe` has different quoting and escaping rules. Consider defaulting to `powershell.exe -Command` for more consistent cross-platform behavior, or document the limitation clearly.

### 4. Document `SQUAD_TEAM_ROOT`

The `SQUAD_TEAM_ROOT` environment variable is a powerful override but is only mentioned in test files. It should be documented in the README under "Configuration" so users know they can use it for monorepo setups.

### 5. Make `squad init --no-workflows` the default for non-git repos

Running `squad init` in a directory without a `.git` folder currently creates GitHub workflow files that will never be used. Add a detection step: if no `.git` parent exists, default to `--no-workflows` and print a note.
