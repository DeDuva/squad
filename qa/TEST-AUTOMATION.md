# Squad QA — Recommendations for Additional Test Automation

**Version:** 0.9.4-build.6
**Date:** 2026-05-03

---

## Current Coverage Summary

The Vitest suite has 6,102 tests covering SDK unit tests, CLI command tests, integration tests, and compatibility tests. 86 are currently failing — all pre-existing and documented.

**Gaps that automation should close:**

| Gap | Risk if Untested |
|-----|-----------------|
| Build integrity (end-to-end from clone) | Workspace linking regressions go undetected |
| `squad doctor` accuracy in user context | False positive erodes user trust, breaks CI |
| `squad init` isolation | Silent write outside project directory |
| `squad init` file completeness | Missing required files cause agent failures |
| Airgap compliance (no bradygaster runtime URLs) | Fork-specific invariant invisible to CI |
| Gemini model catalog correctness | 86 test failures remain if model IDs drift |
| Workstation security | Critical security regression could ship undetected |
| CLI command routing | Undocumented regressions on `--help` |
| Cross-platform timeout/kill | Windows process kill divergence |

---

## Recommended Additions

### 1. Build Integrity Test (`test/build-integrity.test.ts`)

Prevents the workspace-linking regression that caused the initial P0 build failure.

```typescript
import { describe, it, expect } from 'vitest';
import { lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('Workspace linking', () => {
  it('root node_modules/@deduvafork/squad-sdk is a symlink', () => {
    const p = resolve(ROOT, 'node_modules/@deduvafork/squad-sdk');
    expect(existsSync(p)).toBe(true);
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it('packages/squad-cli/node_modules/@deduvafork does NOT exist', () => {
    // If a nested copy exists, TypeScript resolves a stale version
    const p = resolve(ROOT, 'packages/squad-cli/node_modules/@deduvafork');
    expect(existsSync(p)).toBe(false);
  });

  it('packages/squad-cli/node_modules/@bradygaster does NOT exist', () => {
    const p = resolve(ROOT, 'packages/squad-cli/node_modules/@bradygaster');
    expect(existsSync(p)).toBe(false);
  });

  it('packages/squad-sdk/dist/index.d.ts exists after build', () => {
    const p = resolve(ROOT, 'packages/squad-sdk/dist/index.d.ts');
    expect(existsSync(p)).toBe(true);
  });

  it('packages/squad-cli/dist/cli-entry.js exists after build', () => {
    const p = resolve(ROOT, 'packages/squad-cli/dist/cli-entry.js');
    expect(existsSync(p)).toBe(true);
  });
});
```

---

### 2. Init Isolation and Completeness Test (`test/init-isolation.test.ts`)

Verifies `squad init` writes exactly what's expected and nothing outside the target.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const CLI = resolve(import.meta.dirname, '../packages/squad-cli/dist/cli-entry.js');

describe('squad init isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'squad-test-'));
    execSync('git init -q', { cwd: tmpDir });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('does not write files above the target directory', () => {
    const parent = resolve(tmpDir, '..');
    const before = new Set(readdirSync(parent));
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    const after = new Set(readdirSync(parent));
    // only the tmpDir entry should exist (it was already there from mkdtemp)
    expect([...after].filter(f => !before.has(f))).toHaveLength(0);
  });

  it('creates .squad/ inside target directory', () => {
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    expect(existsSync(join(tmpDir, '.squad'))).toBe(true);
  });

  it('creates required .gitattributes merge=union entries', () => {
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    const attrs = readFileSync(join(tmpDir, '.gitattributes'), 'utf-8');
    expect(attrs).toContain('merge=union');
  });

  it('creates squad.agent.md', () => {
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    expect(existsSync(join(tmpDir, '.github/agents/squad.agent.md'))).toBe(true);
  });

  it('creates team.md with ## Members header', () => {
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    const content = readFileSync(join(tmpDir, '.squad/team.md'), 'utf-8');
    expect(content).toContain('## Members');
  });

  it('is idempotent — second run preserves custom team.md content', () => {
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    const teamMd = join(tmpDir, '.squad/team.md');
    const original = readFileSync(teamMd, 'utf-8');
    const modified = original + '\n<!-- custom note -->';
    require('fs').writeFileSync(teamMd, modified);

    execSync(`node "${CLI}" init`, { cwd: tmpDir });
    const after = readFileSync(teamMd, 'utf-8');
    expect(after).toContain('<!-- custom note -->');
  });
});
```

---

### 3. Doctor Accuracy in User Context (`test/doctor-context.test.ts`)

Catches the `squad.js bundle` false positive and any new false positives.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const CLI = resolve(import.meta.dirname, '../packages/squad-cli/dist/cli-entry.js');

describe('squad doctor in user context', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'squad-doctor-'));
    execSync('git init -q', { cwd: tmpDir });
    execSync(`node "${CLI}" init`, { cwd: tmpDir });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('has zero structural failures after init', () => {
    // Unset API key so we only test structural checks
    const result = execSync(`node "${CLI}" doctor`, {
      cwd: tmpDir,
      env: { ...process.env, GEMINI_API_KEY: '' },
      encoding: 'utf-8',
    });
    // Structural checks that should all pass
    expect(result).toContain('✅  .squad/ directory exists');
    expect(result).toContain('✅  team.md found with ## Members header');
    expect(result).toContain('✅  routing.md found');
    expect(result).toContain('✅  agents/ directory exists');
    expect(result).toContain('✅  casting/registry.json exists');
    expect(result).toContain('✅  decisions.md exists');
  });

  it('squad.js bundle check does NOT fail in user project', () => {
    // This test documents the P1 bug — once fixed it should pass naturally
    const result = execSync(`node "${CLI}" doctor`, {
      cwd: tmpDir,
      env: { ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '' },
      encoding: 'utf-8',
    });
    // After the P1 fix, this should pass
    // Until then, document the expected behavior
    const bundleCheck = result.includes('squad.js bundle');
    if (bundleCheck) {
      // It's present — it should either pass or be labeled as skipped, not fail
      expect(result).not.toMatch(/❌.*squad\.js bundle/);
    }
  });
});
```

---

### 4. Airgap Compliance Test (`test/airgap-compliance.test.ts`)

Ensures the fork invariants are maintained on every CI run.

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES_DIR = join(ROOT, 'packages');

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'dist' && entry.name !== 'node_modules') {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Airgap compliance', () => {
  describe('No @github/copilot-sdk imports', () => {
    it('source files contain no copilot-sdk imports', () => {
      const tsFiles = findTsFiles(PACKAGES_DIR);
      const violations = tsFiles.filter(f =>
        readFileSync(f, 'utf-8').includes('@github/copilot-sdk')
      );
      expect(violations).toHaveLength(0);
    });

    it('no package.json has @github/copilot-sdk dependency', () => {
      const pkgFiles = [
        join(ROOT, 'package.json'),
        join(PACKAGES_DIR, 'squad-sdk/package.json'),
        join(PACKAGES_DIR, 'squad-cli/package.json'),
      ];
      for (const f of pkgFiles) {
        const content = readFileSync(f, 'utf-8');
        expect(content).not.toContain('@github/copilot-sdk');
      }
    });
  });

  describe('No @bradygaster/ package imports', () => {
    it('source files contain no @bradygaster/ imports', () => {
      const tsFiles = findTsFiles(PACKAGES_DIR);
      const violations = tsFiles.filter(f => {
        const content = readFileSync(f, 'utf-8');
        return /from ['"]@bradygaster\//.test(content);
      });
      expect(violations).toHaveLength(0);
    });

    it('package.json files have no @bradygaster/ dependencies', () => {
      const pkgFiles = [
        join(PACKAGES_DIR, 'squad-sdk/package.json'),
        join(PACKAGES_DIR, 'squad-cli/package.json'),
      ];
      for (const f of pkgFiles) {
        const pkg = JSON.parse(readFileSync(f, 'utf-8'));
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.optionalDependencies,
          ...pkg.peerDependencies,
        };
        const bradygasterDeps = Object.keys(allDeps).filter(k => k.startsWith('@bradygaster/'));
        expect(bradygasterDeps).toHaveLength(0);
      }
    });
  });

  describe('Workspace symlinks are correct', () => {
    it('@deduvafork/squad-sdk resolves as workspace symlink', () => {
      const { lstatSync } = require('fs');
      const p = join(ROOT, 'node_modules/@deduvafork/squad-sdk');
      expect(existsSync(p)).toBe(true);
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
    });
  });
});
```

---

### 5. Gemini Model Catalog Test (`test/gemini-model-catalog.test.ts`)

Documents the expected Gemini-only catalog and fails fast if a non-Gemini model is added.

```typescript
import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, resolveModel } from '@deduvafork/squad-sdk/config/models';

describe('Gemini model catalog', () => {
  it('all models have provider google', () => {
    for (const [id, model] of Object.entries(MODEL_CATALOG)) {
      expect(model.provider).toBe('google');
    }
  });

  it('all model IDs are gemini family', () => {
    for (const id of Object.keys(MODEL_CATALOG)) {
      expect(id).toMatch(/^gemini-/);
    }
  });

  it('default fallback model is gemini-2.5-flash-preview-04-17', () => {
    const resolved = resolveModel({});
    expect(resolved).toBe('gemini-2.5-flash-preview-04-17');
  });

  it('economy mode maps to cheaper gemini models', () => {
    const expensive = resolveModel({ model: 'gemini-2.5-pro', economyMode: true });
    expect(expensive).toBe('gemini-2.5-flash-preview-04-17');
  });
});
```

---

### 6. CLI Command Routing Smoke Test (`test/cli-routing.test.ts`)

Extends the existing `cli-packaging-smoke.test.ts` to cover all documented commands.

```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../packages/squad-cli/dist/cli-entry.js');

const DOCUMENTED_COMMANDS = [
  'init', 'upgrade', 'status', 'triage', 'watch', 'loop',
  'doctor', 'heartbeat', 'link', 'externalize', 'internalize',
  'export', 'import', 'nap', 'aspire', 'scrub-emails', 'roles',
  'cost', 'cast', 'personal', 'preset', 'build', 'config',
  'auth',
];

describe('CLI command routing — all documented commands', () => {
  for (const cmd of DOCUMENTED_COMMANDS) {
    it(`"${cmd}" is routable (--help does not say "unknown command")`, () => {
      try {
        const output = execSync(`node "${CLI}" ${cmd} --help`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
        expect(output).not.toContain('Unknown command');
        expect(output).not.toContain('unknown command');
      } catch (e: any) {
        // --help may exit 1 for some commands; output is on stderr
        const output = (e.stdout ?? '') + (e.stderr ?? '');
        expect(output).not.toContain('Unknown command');
        expect(output).not.toContain('unknown command');
      }
    });
  }
});
```

---

### 7. Workstation Security Test Suite (`test/workstation-security.test.ts`)

This completes coverage for the security properties documented in the README.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorkstationTools } from '@deduvafork/squad-sdk/workstation-tools';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

describe('Workstation security', () => {
  let rootDir: string;
  let tools: ReturnType<typeof createWorkstationTools>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'squad-wkstn-'));
    tools = createWorkstationTools({ rootDir, bashTimeoutMs: 5000 });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const read = () => tools.find(t => t.name === 'workstation_read_file')!;
  const bash = () => tools.find(t => t.name === 'workstation_bash')!;
  const write = () => tools.find(t => t.name === 'workstation_write_file')!;

  describe('Path traversal prevention', () => {
    it('blocks ../../etc/passwd on read', async () => {
      const r = await read().handler({ path: '../../etc/passwd' });
      expect(r.resultType).toBe('failure');
    });

    it('blocks absolute paths outside rootDir', async () => {
      const r = await read().handler({ path: '/etc/passwd' });
      expect(r.resultType).toBe('failure');
    });

    it('blocks symlinks that escape rootDir', async () => {
      const link = join(rootDir, 'evil');
      symlinkSync(tmpdir(), link);
      const r = await read().handler({ path: 'evil/../../etc/passwd' });
      expect(r.resultType).toBe('failure');
    });

    it('allows reads within rootDir', async () => {
      writeFileSync(join(rootDir, 'ok.txt'), 'hello');
      const r = await read().handler({ path: 'ok.txt' });
      expect(r.resultType).toBe('success');
    });

    it('blocks ../../ writes', async () => {
      const r = await write().handler({ path: '../../tmp/evil.txt', content: 'evil' });
      expect(r.resultType).toBe('failure');
    });
  });

  describe('Environment sanitisation', () => {
    it('strips GEMINI_API_KEY before shell execution', async () => {
      process.env.GEMINI_API_KEY = 'should-be-stripped';
      const r = await bash().handler({
        command: 'printenv GEMINI_API_KEY || echo STRIPPED',
      });
      delete process.env.GEMINI_API_KEY;
      expect(r.textResultForLlm).toContain('STRIPPED');
    });

    it('strips NODE_OPTIONS', async () => {
      process.env.NODE_OPTIONS = '--require evil';
      const r = await bash().handler({ command: 'printenv NODE_OPTIONS || echo STRIPPED' });
      delete process.env.NODE_OPTIONS;
      expect(r.textResultForLlm).toContain('STRIPPED');
    });

    it('preserves non-sensitive env vars', async () => {
      process.env.SQUAD_TEST_SAFE = 'hello';
      const r = await bash().handler({ command: 'printenv SQUAD_TEST_SAFE' });
      delete process.env.SQUAD_TEST_SAFE;
      expect(r.textResultForLlm).toContain('hello');
    });
  });

  describe('Timeout clamping', () => {
    it('enforces host ceiling when agent requests higher timeout', async () => {
      const capped = createWorkstationTools({ rootDir, bashTimeoutMs: 500 });
      const b = capped.find(t => t.name === 'workstation_bash')!;
      const r = await b.handler({ command: 'sleep 5', timeout_ms: 999999 });
      expect(r.resultType).toBe('failure');
    });
  });

  describe('Write cap', () => {
    it('rejects files over 10 MB', async () => {
      const big = 'x'.repeat(10 * 1024 * 1024 + 1);
      const r = await write().handler({ path: 'big.txt', content: big });
      expect(r.resultType).toBe('failure');
    });

    it('rejects binary files on read', async () => {
      writeFileSync(join(rootDir, 'bin'), Buffer.from([0x00, 0x01]));
      const r = await read().handler({ path: 'bin' });
      expect(r.resultType).toBe('failure');
    });
  });
});
```

---

### 8. Cross-Platform Process Kill Test (Windows-only)

```typescript
describe.skipIf(process.platform !== 'win32')('Windows process tree kill', () => {
  it('kills background processes started with "start /B"', async () => {
    const tools = createWorkstationTools({ rootDir, bashTimeoutMs: 1000 });
    const b = tools.find(t => t.name === 'workstation_bash')!;
    const r = await b.handler({ command: 'start /B timeout /t 10 > nul' });
    expect(r.resultType).toBe('failure');
    // Process should be killed by timeout, not hang
  });
});
```

---

## CI Pipeline Recommendations

### Pre-build sanity check step

```yaml
# .github/workflows/squad-ci.yml
- name: Verify no stale nested SDK
  run: |
    if [ -d "packages/squad-cli/node_modules/@bradygaster" ]; then
      echo "ERROR: Stale @bradygaster nested copy found"
      exit 1
    fi
    if [ -d "packages/squad-cli/node_modules/@deduvafork/squad-sdk" ]; then
      echo "ERROR: Stale @deduvafork nested copy found — workspace linking broken"
      exit 1
    fi
```

### Add airgap compliance to CI gate

```yaml
- name: Airgap compliance check
  run: npm test -- --project test/airgap-compliance.test.ts
```

### Test coverage thresholds

```typescript
// vitest.config.ts
coverage: {
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
  }
}
```

### Gate CI on zero new failures

The test suite currently allows 86 pre-existing failures. CI should fail if the failure count increases:

```yaml
- name: Run tests
  run: |
    npm test 2>&1 | tee test-output.txt
    FAILURES=$(grep -oP '\d+ failed' test-output.txt | grep -oP '\d+' | head -1)
    if [ "$FAILURES" -gt "86" ]; then
      echo "New test failures detected: $FAILURES (baseline: 86)"
      exit 1
    fi
```
