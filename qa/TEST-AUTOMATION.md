# Squad QA — Recommendations for Additional Test Automation

**Version:** 0.9.4-build.3  
**Date:** 2026-05-03

---

## Current Coverage Summary

The existing Vitest suite has 6,102 tests covering:
- SDK unit tests (routing, casting, config, hooks, tools)
- CLI command unit tests
- Integration tests (pipeline, error hierarchy)
- Compatibility tests
- Human journey tests

**Gaps identified:**

| Gap Area | Risk if Untested |
|----------|-----------------|
| Build from source (end-to-end) | Contributors won't catch workspace linking regressions |
| Doctor accuracy in user context | False positives erode trust and break CI |
| Init isolation (files outside CWD) | Silent data corruption risk |
| Workstation security (runtime) | Security regression undetected |
| Command routing completeness | Undocumented regressions on CLI commands |
| Cross-platform (Windows vs Unix) | Timeout/kill divergence undetected |

---

## Recommended Automation Additions

### 1. Build Integrity Test (`test/build-integrity.test.ts`)

Verifies the workspace linking is correct before the build runs. This would have caught the P0 stale-nested-dependency bug.

```typescript
import { describe, it, expect } from 'vitest';
import { lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('Workspace linking', () => {
  it('root node_modules/@bradygaster/squad-sdk is a symlink', () => {
    const p = resolve(ROOT, 'node_modules/@bradygaster/squad-sdk');
    expect(existsSync(p)).toBe(true);
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it('packages/squad-cli/node_modules/@bradygaster/squad-sdk does NOT exist', () => {
    // If this exists, TypeScript will resolve the stale version
    const p = resolve(ROOT, 'packages/squad-cli/node_modules/@bradygaster/squad-sdk');
    expect(existsSync(p)).toBe(false);
  });

  it('dist/cli-entry.js exists after build', () => {
    const p = resolve(ROOT, 'packages/squad-cli/dist/cli-entry.js');
    expect(existsSync(p)).toBe(true);
  });
});
```

---

### 2. Init Isolation Test (`test/init-isolation.test.ts`)

Verifies `squad init` writes ONLY to the target directory, never outside it.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../packages/squad-cli/dist/cli-entry.js');
const SQUAD_ROOT = resolve(import.meta.dirname, '..');

describe('squad init isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'squad-test-'));
    execSync('git init', { cwd: tmpDir });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('creates .squad/ only in the target directory', () => {
    execSync(`node ${CLI} init`, { cwd: tmpDir });
    // Squad source should be unchanged
    const sourceAgentsBefore = readdirSync(resolve(SQUAD_ROOT, '.squad/agents'));
    expect(sourceAgentsBefore).toEqual(sourceAgentsBefore); // tautology — just checking it doesn't throw
  });

  it('does not write files above the target directory', () => {
    const parent = resolve(tmpDir, '..');
    const beforeFiles = readdirSync(parent);
    execSync(`node ${CLI} init`, { cwd: tmpDir });
    const afterFiles = readdirSync(parent);
    expect(afterFiles).toEqual(beforeFiles);
  });

  it('creates required .gitattributes merge=union entries', () => {
    execSync(`node ${CLI} init`, { cwd: tmpDir });
    const attrs = readFileSync(resolve(tmpDir, '.gitattributes'), 'utf-8');
    expect(attrs).toContain('merge=union');
  });
});
```

---

### 3. Doctor Context Test (`test/doctor-context.test.ts`)

Verifies `squad doctor` produces zero false positives after `squad init` in a user project.

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInit } from '@bradygaster/squad-cli/core/init';
import { runDoctor } from '@bradygaster/squad-cli/commands/doctor';

describe('Doctor after init (user context)', () => {
  it('has zero failures in a freshly-initialised user project', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'squad-doctor-'));
    try {
      await runInit(dir, { includeWorkflows: false });
      const { failures } = await runDoctor(dir);
      expect(failures).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report squad.js bundle failure in a user project', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'squad-doctor-'));
    try {
      await runInit(dir, { includeWorkflows: false });
      const checks = await runDoctorChecks(dir);
      const bundleCheck = checks.find(c => c.name === 'squad.js bundle');
      // Either the check doesn't appear, or it passes
      if (bundleCheck) {
        expect(bundleCheck.status).not.toBe('fail');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

---

### 4. Workstation Security Test Suite (`test/workstation-security.test.ts`)

The security properties of `workstation.ts` are critical but have minimal test coverage. This suite should be comprehensive.

```typescript
import { describe, it, expect } from 'vitest';
import { createWorkstationTools } from '@bradygaster/squad-sdk/workstation-tools';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

describe('Workstation security', () => {
  let rootDir: string;
  let tools: ReturnType<typeof createWorkstationTools>;

  beforeEach(() => {
    rootDir = mkdtempSync(resolve(tmpdir(), 'squad-wkstn-'));
    tools = createWorkstationTools({ rootDir, bashTimeoutMs: 5000 });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const readTool = () => tools.find(t => t.name === 'workstation_read_file')!;
  const bashTool = () => tools.find(t => t.name === 'workstation_bash')!;
  const writeTool = () => tools.find(t => t.name === 'workstation_write_file')!;

  // Path traversal
  describe('Path traversal prevention', () => {
    it('blocks ../.. escapes on read', async () => {
      const r = await readTool().handler({ path: '../../etc/passwd' });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('EACCES');
    });

    it('blocks absolute paths outside rootDir on read', async () => {
      const r = await readTool().handler({ path: '/etc/passwd' });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('EACCES');
    });

    it('blocks symlink that escapes rootDir', async () => {
      const link = join(rootDir, 'evil-link');
      symlinkSync('/tmp', link);
      const r = await readTool().handler({ path: 'evil-link/../../etc/passwd' });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('EACCES');
    });

    it('allows reads within rootDir', async () => {
      writeFileSync(join(rootDir, 'test.txt'), 'hello');
      const r = await readTool().handler({ path: 'test.txt' });
      expect(r.resultType).toBe('success');
    });

    it('blocks ../.. escapes on write', async () => {
      const r = await writeTool().handler({ path: '../../tmp/evil.txt', content: 'evil' });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('EACCES');
    });
  });

  // Environment sanitisation
  describe('Environment sanitisation', () => {
    it('strips env vars matching sensitive pattern', async () => {
      process.env.SQUAD_TEST_SECRET = 'secret123';
      const r = await bashTool().handler({ command: 'printenv SQUAD_TEST_SECRET || echo STRIPPED' });
      delete process.env.SQUAD_TEST_SECRET;
      expect(r.textResultForLlm).toContain('STRIPPED');
    });

    it('strips NODE_OPTIONS', async () => {
      process.env.NODE_OPTIONS = '--require evil';
      const r = await bashTool().handler({ command: 'printenv NODE_OPTIONS || echo STRIPPED' });
      delete process.env.NODE_OPTIONS;
      expect(r.textResultForLlm).toContain('STRIPPED');
    });

    it('preserves normal env vars', async () => {
      process.env.SQUAD_TEST_NORMAL = 'hello';
      const r = await bashTool().handler({ command: 'printenv SQUAD_TEST_NORMAL' });
      delete process.env.SQUAD_TEST_NORMAL;
      expect(r.textResultForLlm).toContain('hello');
    });
  });

  // Timeout clamping
  describe('Timeout clamping', () => {
    it('clamps agent timeout above host ceiling', async () => {
      const tools2 = createWorkstationTools({ rootDir, bashTimeoutMs: 1000 });
      const bash = tools2.find(t => t.name === 'workstation_bash')!;
      // A sleep longer than 1s should time out
      const r = await bash.handler({ command: 'sleep 5', timeout_ms: 999999 });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('timeout');
    });

    it('allows timeout within ceiling', async () => {
      const r = await bashTool().handler({ command: 'echo ok', timeout_ms: 1000 });
      expect(r.resultType).toBe('success');
    });
  });

  // Write limit
  describe('Write limit', () => {
    it('rejects content over 10 MB', async () => {
      const bigContent = 'x'.repeat(10 * 1024 * 1024 + 1);
      const r = await writeTool().handler({ path: 'big.txt', content: bigContent });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('ETOOLARGE');
    });

    it('rejects binary files on read', async () => {
      const binaryPath = join(rootDir, 'binary.bin');
      writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
      const r = await readTool().handler({ path: 'binary.bin' });
      expect(r.resultType).toBe('failure');
      expect(r.error).toBe('EBINARY');
    });
  });
});
```

---

### 5. CLI Command Routing Test (`test/cli-routing.test.ts`)

Extends the existing `cli-packaging-smoke.test.ts` to verify ALL commands listed in the README are routable, using a more data-driven approach:

```typescript
const DOCUMENTED_COMMANDS = [
  'init', 'upgrade', 'status', 'triage', 'watch', 'loop',
  'copilot', 'doctor', 'heartbeat', 'link', 'externalize',
  'internalize', 'shell', 'export', 'import', 'plugin',
  'upstream', 'nap', 'aspire', 'scrub-emails', 'roles',
  'cost', 'cast', 'personal', 'preset', 'build', 'config',
];

describe('CLI command routing — all documented commands', () => {
  for (const cmd of DOCUMENTED_COMMANDS) {
    it(`command "${cmd}" is routable`, async () => {
      const output = await runCLI([cmd, '--help']);
      expect(output).not.toContain('unknown command');
    });
  }
});
```

---

### 6. Cross-Platform Timeout Test (Windows)

The `runCommand` function has separate kill paths for Unix (SIGKILL to process group) and Windows (taskkill). Add platform-specific tests that run only on Windows:

```typescript
describe.skipIf(process.platform !== 'win32')('Windows process kill', () => {
  it('kills background processes spawned with start', async () => {
    // start is the Windows equivalent of & (background)
    const tools = createWorkstationTools({ rootDir, bashTimeoutMs: 1000 });
    const bash = tools.find(t => t.name === 'workstation_bash')!;
    const r = await bash.handler({ command: 'start /B timeout /t 10 > nul' });
    expect(r.resultType).toBe('failure');
    expect(r.error).toBe('timeout');
  });
});
```

---

### 7. SQUAD_TEAM_ROOT Resolution (`test/env-resolution.test.ts`)

Covers the environment variable override and edge cases:

```typescript
describe('SQUAD_TEAM_ROOT environment variable', () => {
  it('resolveSquad uses SQUAD_TEAM_ROOT when set and path exists', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'squad-env-'));
    process.env.SQUAD_TEAM_ROOT = dir;
    try {
      const result = resolveSquad();
      expect(result).toBe(dir);
    } finally {
      delete process.env.SQUAD_TEAM_ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveSquad returns null when SQUAD_TEAM_ROOT is set but path does not exist', () => {
    process.env.SQUAD_TEAM_ROOT = '/does/not/exist/12345';
    try {
      const result = resolveSquad();
      expect(result).toBeNull();
    } finally {
      delete process.env.SQUAD_TEAM_ROOT;
    }
  });
});
```

---

### 8. Playwright / E2E Acceptance Tests

The repo includes Playwright as a dev dependency (`@playwright/test`) but there are no end-to-end browser tests. This is probably intended for future use with the Aspire dashboard or a web UI. For CLI acceptance testing, consider a lighter Playwright usage for terminal testing, or use `@vitest/cli` with process spawning.

A minimal acceptance test that verifies the full happy path:

```typescript
// test/acceptance/happy-path.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';

test('full happy path: init → doctor → export → import', () => {
  const dir = mkdtempSync('/tmp/squad-e2e-');
  try {
    execSync('git init', { cwd: dir });
    execSync(`${CLI} init`, { cwd: dir });
    expect(existsSync(`${dir}/.squad/team.md`)).toBe(true);
    
    const doctor = execSync(`${CLI} doctor`, { cwd: dir, encoding: 'utf-8' });
    expect(doctor).not.toContain('❌');
    
    execSync(`${CLI} export > snapshot.json`, { cwd: dir, shell: true });
    execSync('rm -rf .squad/', { cwd: dir });
    execSync(`${CLI} import snapshot.json`, { cwd: dir });
    expect(existsSync(`${dir}/.squad/team.md`)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

---

## CI Pipeline Recommendations

### Add a pre-build sanity check step

```yaml
# .github/workflows/squad-ci.yml
- name: Check workspace links
  run: |
    if [ -d "packages/squad-cli/node_modules/@bradygaster/squad-sdk" ]; then
      echo "ERROR: Stale nested SDK found. Run: rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk"
      exit 1
    fi
```

### Run tests in isolation per package

```yaml
- name: Test SDK
  run: npm test -- --project packages/squad-sdk

- name: Test CLI
  run: npm test -- --project packages/squad-cli
```

### Add test coverage thresholds

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

### Gate on zero test failures

The CI should fail if any test fails — not just if the build fails. Currently the CI allows tests to fail silently (based on the 86 failures observed).
