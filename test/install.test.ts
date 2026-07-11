/**
 * M4-12: Download & install tests
 * Tests for CI pipeline generation, version stamping, changelog, and install migration.
 */
import { describe, it, expect } from 'vitest';
import {
  generateGitHubActionsWorkflow,
  generateReleaseWorkflow,
  validatePipelineConfig,
  getDefaultSteps,
  type CIPipelineConfig,
} from '@deduvafork/squad-sdk/build';
import {
  parseConventionalCommit,
  bumpVersion,
  stampVersion,
  generateChangelog,
  type CommitInfo,
} from '@deduvafork/squad-sdk/build';
import {
  detectInstallMethod,
  migrateInstallPath,
  generateMigrationInstructions,
} from '@deduvafork/squad-sdk/build';

// --- Helpers ---

function makeConfig(overrides?: Partial<CIPipelineConfig>): CIPipelineConfig {
  return {
    name: 'CI',
    steps: [
      { name: 'Lint', command: 'npm run lint' },
      { name: 'Test', command: 'npm test' },
    ],
    triggers: [{ event: 'push', branches: ['main'] }],
    artifacts: [],
    environment: {},
    ...overrides,
  };
}

function makeCommit(overrides?: Partial<CommitInfo>): CommitInfo {
  return {
    sha: 'abc1234567890',
    message: 'feat: add something',
    author: 'dev',
    date: '2025-01-01',
    type: 'feat',
    ...overrides,
  };
}

// ========== CI Pipeline ==========

describe('CI Pipeline', () => {
  it('should generate a valid GitHub Actions workflow', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig());
    expect(yaml).toContain('name: CI');
    expect(yaml).toContain('push:');
    expect(yaml).toContain('branches:');
    expect(yaml).toContain('- main');
    expect(yaml).toContain('npm ci');
  });

  it('should include all configured steps', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig());
    expect(yaml).toContain('name: Lint');
    expect(yaml).toContain('npm run lint');
    expect(yaml).toContain('name: Test');
    expect(yaml).toContain('npm test');
  });

  it('should include environment variables', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      environment: { NODE_ENV: 'test', CI: 'true' },
    }));
    expect(yaml).toContain('env:');
    expect(yaml).toContain('NODE_ENV: test');
    expect(yaml).toContain('CI: true');
  });

  it('should support pull_request trigger', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      triggers: [{ event: 'pull_request', branches: ['main'] }],
    }));
    expect(yaml).toContain('pull_request:');
  });

  it('should support schedule trigger', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      triggers: [{ event: 'schedule', cron: '0 0 * * *' }],
    }));
    expect(yaml).toContain('schedule:');
    expect(yaml).toContain("cron: '0 0 * * *'");
  });

  it('should support workflow_dispatch trigger', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      triggers: [{ event: 'workflow_dispatch' }],
    }));
    expect(yaml).toContain('workflow_dispatch:');
  });

  it('should include artifacts when configured', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      artifacts: [{ name: 'dist', path: './dist', retention: 5 }],
    }));
    expect(yaml).toContain('actions/upload-artifact@v4');
    expect(yaml).toContain('name: dist');
    expect(yaml).toContain('path: ./dist');
    expect(yaml).toContain('retention-days: 5');
  });

  it('should use custom node version', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({ nodeVersion: '22' }));
    expect(yaml).toContain("node-version: '22'");
  });

  it('should generate a release workflow with publish and tag steps', () => {
    const yaml = generateReleaseWorkflow(makeConfig());
    expect(yaml).toContain('Release');
    expect(yaml).toContain('release:');
    expect(yaml).toContain('npm publish --access public');
    expect(yaml).toContain('git tag');
  });

  it('should return default steps', () => {
    const steps = getDefaultSteps();
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.some(s => s.name === 'Lint')).toBe(true);
    expect(steps.some(s => s.name === 'Test')).toBe(true);
    expect(steps.some(s => s.name === 'Build')).toBe(true);
  });

  it('should include step conditions', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      steps: [{ name: 'Deploy', command: 'deploy.sh', condition: "github.ref == 'refs/heads/main'" }],
    }));
    expect(yaml).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('should include step env vars', () => {
    const yaml = generateGitHubActionsWorkflow(makeConfig({
      steps: [{ name: 'Publish', command: 'npm publish', env: { NPM_TOKEN: 'secret' } }],
    }));
    expect(yaml).toContain('NPM_TOKEN: secret');
  });
});

// ========== Pipeline Validation ==========

describe('Pipeline Validation', () => {
  it('should validate a valid config', () => {
    const result = validatePipelineConfig(makeConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should error on missing name', () => {
    const result = validatePipelineConfig(makeConfig({ name: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('should error on empty steps', () => {
    const result = validatePipelineConfig(makeConfig({ steps: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('step'))).toBe(true);
  });

  it('should error on empty triggers', () => {
    const result = validatePipelineConfig(makeConfig({ triggers: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('trigger'))).toBe(true);
  });

  it('should error on schedule trigger without cron', () => {
    const result = validatePipelineConfig(makeConfig({
      triggers: [{ event: 'schedule' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('cron'))).toBe(true);
  });

  it('should warn when no lint step', () => {
    const result = validatePipelineConfig(makeConfig({
      steps: [{ name: 'Test', command: 'npm test' }],
    }));
    expect(result.warnings.some(w => w.includes('lint'))).toBe(true);
  });

  it('should warn when no test step', () => {
    const result = validatePipelineConfig(makeConfig({
      steps: [{ name: 'Build', command: 'npm run build' }],
    }));
    expect(result.warnings.some(w => w.includes('test'))).toBe(true);
  });
});

// ========== Versioning ==========

describe('Version Bumping', () => {
  it('should bump major version', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  it('should bump minor version', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  it('should bump patch version', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  it('should bump prerelease with existing prerelease tag', () => {
    expect(bumpVersion('1.2.3-alpha.0', 'prerelease')).toBe('1.2.3-alpha.1');
  });

  it('should create new prerelease from stable', () => {
    expect(bumpVersion('1.2.3', 'prerelease')).toBe('1.2.4-alpha.0');
  });

  it('should throw on invalid version', () => {
    expect(() => bumpVersion('not-a-version', 'patch')).toThrow('Invalid semver');
  });
});

describe('Conventional Commit Parsing', () => {
  it('should parse feat commit', () => {
    const result = parseConventionalCommit('feat: add login page');
    expect(result.type).toBe('feat');
    expect(result.description).toBe('add login page');
    expect(result.scope).toBeNull();
    expect(result.breaking).toBe(false);
  });

  it('should parse fix with scope', () => {
    const result = parseConventionalCommit('fix(auth): resolve token refresh');
    expect(result.type).toBe('fix');
    expect(result.scope).toBe('auth');
    expect(result.description).toBe('resolve token refresh');
  });

  it('should detect breaking change with bang', () => {
    const result = parseConventionalCommit('feat!: remove deprecated API');
    expect(result.breaking).toBe(true);
  });

  it('should detect breaking change with scope and bang', () => {
    const result = parseConventionalCommit('refactor(core)!: rewrite engine');
    expect(result.breaking).toBe(true);
    expect(result.scope).toBe('core');
  });

  it('should return "other" for non-conventional messages', () => {
    const result = parseConventionalCommit('random commit message');
    expect(result.type).toBe('other');
  });
});

describe('Changelog Generation', () => {
  it('should generate changelog with features and fixes', () => {
    const commits: CommitInfo[] = [
      makeCommit({ sha: 'aaa1111', message: 'feat: add export', type: 'feat' }),
      makeCommit({ sha: 'bbb2222', message: 'fix: crash on load', type: 'fix' }),
    ];
    const log = generateChangelog(commits, '1.0.0');
    expect(log).toContain('## 1.0.0');
    expect(log).toContain('### Features');
    expect(log).toContain('### Bug Fixes');
    expect(log).toContain('aaa1111');
    expect(log).toContain('bbb2222');
  });

  it('should include breaking changes section', () => {
    const commits: CommitInfo[] = [
      makeCommit({ sha: 'ccc3333', message: 'feat!: remove old API', type: 'feat' }),
    ];
    const log = generateChangelog(commits, '2.0.0');
    expect(log).toContain('BREAKING CHANGES');
    expect(log).toContain('remove old API');
  });

  it('should include date in header', () => {
    const log = generateChangelog([], '1.0.0');
    const today = new Date().toISOString().slice(0, 10);
    expect(log).toContain(today);
  });
});

describe('Version Stamping', () => {
  it('should return stamp entries for each file', () => {
    const result = stampVersion('2.0.0', ['package.json', 'version.txt']);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('package.json');
    expect(result[0].content).toBe('2.0.0');
  });
});

// ========== Install Migration ==========

describe('Install Method Detection', () => {
  it('should return a valid install method', () => {
    const method = detectInstallMethod();
    expect(['npx-github', 'npm-global', 'npm-local', 'unknown']).toContain(method);
  });
});

describe('Install Migration', () => {
  it('should return no-op when from === to', () => {
    const plan = migrateInstallPath('npm-global', 'npm-global');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toContain('No migration');
  });

  it('should handle unknown source method', () => {
    const plan = migrateInstallPath('unknown', 'npm-global');
    expect(plan.steps[0].manual).toBe(true);
  });

  it('should generate steps for npx-github to npm-global', () => {
    const plan = migrateInstallPath('npx-github', 'npm-global');
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.some(s => s.command?.includes('npm install -g'))).toBe(true);
  });

  it('should generate steps for npm-global to npm-local', () => {
    const plan = migrateInstallPath('npm-global', 'npm-local');
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('should generate steps for npm-local to npm-global', () => {
    const plan = migrateInstallPath('npm-local', 'npm-global');
    expect(plan.steps.some(s => s.command?.includes('npm install -g'))).toBe(true);
  });
});

describe('Migration Instructions', () => {
  it('should generate markdown instructions', () => {
    const md = generateMigrationInstructions('npx-github', 'npm-global');
    expect(md).toContain('# Migrate from');
    expect(md).toContain('```bash');
    expect(md).toContain('npm install -g');
  });

  it('should handle same method gracefully', () => {
    const md = generateMigrationInstructions('npm-global', 'npm-global');
    expect(md).toContain('No migration needed');
  });

  it('should generate numbered steps', () => {
    const md = generateMigrationInstructions('npx-github', 'npm-local');
    expect(md).toContain('1.');
    expect(md).toContain('2.');
  });
});
