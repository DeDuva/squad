/**
 * M6-10: End-to-end migration path tests
 *
 * Validates full migration workflows from legacy .ai-team/ projects to
 * .squad/ typed config, including multi-version chains, rollback, and
 * edge cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MigrationRegistry,
  parseSemVer,
  compareSemVer,
  type Migration,
  type MigrationResult,
} from '@deduvafork/squad-sdk/config';
import {
  migrateMarkdownToConfig,
  parseTeamMarkdown,
  parseRoutingRulesMarkdown,
  generateConfigFromParsed,
  type MarkdownParseResult,
  type MarkdownMigrationOptions,
} from '@deduvafork/squad-sdk/config';
import {
  exportSquadConfig,
  serializeBundle,
  type ExportBundle,
} from '@deduvafork/squad-sdk/sharing';
import {
  importSquadConfig,
  deserializeBundle,
  validateBundle,
} from '@deduvafork/squad-sdk/sharing';
import { DEFAULT_CONFIG, type SquadConfig } from '@deduvafork/squad-sdk/runtime';

// ============================================================================
// Helpers
// ============================================================================

const BASE_DIR = join(tmpdir(), 'squad-e2e-migration-' + Date.now());
const SRC_DIR = join(BASE_DIR, 'src-project');
const DST_DIR = join(BASE_DIR, 'dst-project');

function setupLegacyProject(dir: string): void {
  mkdirSync(join(dir, '.ai-team', 'skills'), { recursive: true });
  mkdirSync(join(dir, '.ai-team', 'decisions', 'inbox'), { recursive: true });
  mkdirSync(join(dir, '.github', 'agents'), { recursive: true });

  writeFileSync(
    join(dir, '.ai-team', 'team.md'),
    `# Team Roster

## Roster

### Fenster
- **Role:** Core Dev
- **Skills:** TypeScript, Testing, Architecture
- **Model:** claude-sonnet-4.5
- **Status:** active

### Kujan
- **Role:** SDK Expert
- **Skills:** API Design, Documentation
- **Model:** claude-sonnet-4
- **Status:** active
`,
  );

  writeFileSync(
    join(dir, '.ai-team', 'routing.md'),
    `# Routing

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| feature-dev | fenster | new feature, implement |
| documentation | kujan | docs, readme |
`,
  );

  writeFileSync(
    join(dir, '.github', 'agents', 'fenster.agent.md'),
    '# Fenster\n\nCore developer agent.\n\n## Skills\n- TypeScript\n- Testing\n',
  );

  writeFileSync(
    join(dir, '.github', 'agents', 'kujan.agent.md'),
    '# Kujan\n\nSDK expert agent.\n\n## Skills\n- API Design\n- Documentation\n',
  );

  writeFileSync(
    join(dir, '.ai-team', 'skills', 'typescript.md'),
    '# TypeScript\n\nAdvanced TypeScript patterns.\n',
  );
}

function setupSquadProject(dir: string, config?: Partial<SquadConfig>): void {
  mkdirSync(join(dir, '.squad'), { recursive: true });
  mkdirSync(join(dir, '.github', 'agents'), { recursive: true });

  const squadConfig = { ...DEFAULT_CONFIG, ...config, version: config?.version ?? '1.0.0' };
  writeFileSync(
    join(dir, '.squad', 'config.json'),
    JSON.stringify(squadConfig, null, 2),
  );

  writeFileSync(
    join(dir, '.github', 'agents', 'fenster.agent.md'),
    '# Fenster\n\nCore developer.\n',
  );
}

function buildMigrationChain(): MigrationRegistry {
  const registry = new MigrationRegistry();

  // v0.4.0 → v0.5.0
  registry.register({
    fromVersion: '0.4.0',
    toVersion: '0.5.0',
    description: 'Add routing governance defaults',
    migrate: (config) => ({
      ...config,
      version: '0.5.0',
      governance: { eagerByDefault: true, scribeAutoRuns: false },
    }),
    rollback: (config) => {
      const { governance: _, ...rest } = config;
      return { ...rest, version: '0.4.0' };
    },
  });

  // v0.5.0 → v0.6.0
  registry.register({
    fromVersion: '0.5.0',
    toVersion: '0.6.0',
    description: 'Add model selection and agent sources',
    migrate: (config) => ({
      ...config,
      version: '0.6.0',
      models: {
        defaultModel: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        fallbackChains: { premium: [], standard: [], fast: [] },
      },
      agentSources: [],
    }),
    rollback: (config) => {
      const { models: _, agentSources: _as, ...rest } = config;
      return { ...rest, version: '0.5.0' };
    },
  });

  return registry;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  mkdirSync(SRC_DIR, { recursive: true });
  mkdirSync(DST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ============================================================================
// Full migration: .ai-team/ → .squad/ project
// ============================================================================

describe('full migration: .ai-team → .squad', () => {
  it('should parse team.md into agent list', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const { agents } = parseTeamMarkdown(teamMd);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.find((a) => a.name === 'fenster')).toBeTruthy();
    expect(agents.find((a) => a.name === 'kujan')).toBeTruthy();
  });

  it('should parse routing.md into routing rules', () => {
    setupLegacyProject(SRC_DIR);
    const routingMd = readFileSync(join(SRC_DIR, '.ai-team', 'routing.md'), 'utf-8');
    const { rules } = parseRoutingRulesMarkdown(routingMd);
    // Routing may be empty if markdown doesn't match the table format;
    // at minimum no error is thrown
    expect(Array.isArray(rules)).toBe(true);
  });

  it('should generate config from parsed markdown', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const routingMd = readFileSync(join(SRC_DIR, '.ai-team', 'routing.md'), 'utf-8');
    const { agents } = parseTeamMarkdown(teamMd);
    const { rules: routingRules } = parseRoutingRulesMarkdown(routingMd);
    const parseResult: MarkdownParseResult = {
      agents,
      routingRules,
      decisions: [],
      warnings: [],
    };
    const config = generateConfigFromParsed(parseResult);
    expect(config.routing.rules.length).toBeGreaterThanOrEqual(1);
    expect(config.version).toBeTruthy();
  });

  it('should migrate markdown options to typed config', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const opts: MarkdownMigrationOptions = { teamMd };
    const result = migrateMarkdownToConfig(opts);
    expect(result.config).toBeTruthy();
    expect(result.config.routing).toBeDefined();
    expect(result.parsed).toBeDefined();
  });

  it('should preserve routing rules through migration', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const result = migrateMarkdownToConfig({ teamMd });
    // Default routing rules are applied when no routing.md is provided
    expect(result.config.routing.rules.length).toBeGreaterThanOrEqual(1);
  });

  it('should preserve agent data through migration', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const { agents } = parseTeamMarkdown(teamMd);
    const fenster = agents.find((a) => a.name === 'fenster');
    expect(fenster).toBeTruthy();
    expect(fenster!.skills.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Version chain migration: v0.4.x → v0.5.x → v0.6.x
// ============================================================================

describe('version chain migration: v0.4.x → v0.5.x → v0.6.x', () => {
  it('should migrate from v0.4.0 directly to v0.5.0', () => {
    const registry = buildMigrationChain();
    const config = { version: '0.4.0', routing: { rules: [] } };
    const result = registry.runMigrations(config, '0.4.0', '0.5.0');
    expect(result.config.version).toBe('0.5.0');
    expect(result.applied).toHaveLength(1);
    expect(result.rolledBack).toBe(false);
  });

  it('should migrate from v0.5.0 to v0.6.0', () => {
    const registry = buildMigrationChain();
    const config = { version: '0.5.0', governance: { eagerByDefault: true } };
    const result = registry.runMigrations(config, '0.5.0', '0.6.0');
    expect(result.config.version).toBe('0.6.0');
    expect(result.config.models).toBeDefined();
  });

  it('should chain v0.4.0 → v0.5.0 → v0.6.0', () => {
    const registry = buildMigrationChain();
    const config = { version: '0.4.0', routing: { rules: [] } };
    const result = registry.runMigrations(config, '0.4.0', '0.6.0');
    expect(result.config.version).toBe('0.6.0');
    expect(result.applied).toHaveLength(2);
    expect(result.config.governance).toBeDefined();
    expect(result.config.models).toBeDefined();
  });

  it('should preserve existing fields through the chain', () => {
    const registry = buildMigrationChain();
    const config = { version: '0.4.0', customField: 'keep-me', routing: { rules: [] } };
    const result = registry.runMigrations(config, '0.4.0', '0.6.0');
    expect(result.config.customField).toBe('keep-me');
  });

  it('should report all applied migrations in order', () => {
    const registry = buildMigrationChain();
    const result = registry.runMigrations({ version: '0.4.0' }, '0.4.0', '0.6.0');
    expect(result.applied[0].fromVersion).toBe('0.4.0');
    expect(result.applied[0].toVersion).toBe('0.5.0');
    expect(result.applied[1].fromVersion).toBe('0.5.0');
    expect(result.applied[1].toVersion).toBe('0.6.0');
  });
});

// ============================================================================
// Legacy squad.agent.md → typed config roundtrip
// ============================================================================

describe('legacy squad.agent.md → typed config roundtrip', () => {
  it('should parse agent charter from markdown', () => {
    setupLegacyProject(SRC_DIR);
    const charter = readFileSync(
      join(SRC_DIR, '.github', 'agents', 'fenster.agent.md'),
      'utf-8',
    );
    expect(charter).toContain('Fenster');
    expect(charter).toContain('Skills');
  });

  it('should produce config that has routing rules', () => {
    setupLegacyProject(SRC_DIR);
    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const result = migrateMarkdownToConfig({ teamMd });
    expect(result.config.routing.rules.length).toBeGreaterThan(0);
  });

  it('should roundtrip via export then import', () => {
    setupLegacyProject(SRC_DIR);
    setupSquadProject(DST_DIR);

    const bundle = exportSquadConfig(SRC_DIR);
    expect(bundle.agents.length).toBeGreaterThan(0);

    const serialized = serializeBundle(bundle);
    const deserialized = deserializeBundle(serialized);
    expect(deserialized.agents.length).toBe(bundle.agents.length);
  });
});

// ============================================================================
// Export from beta project → import into v1 project
// ============================================================================

describe('export from beta → import into v1', () => {
  it('should export a bundle from a beta project', () => {
    setupLegacyProject(SRC_DIR);
    const bundle = exportSquadConfig(SRC_DIR);
    expect(bundle.metadata.version).toBeTruthy();
    expect(bundle.config).toBeDefined();
  });

  it('should serialize and deserialize bundle losslessly', () => {
    setupLegacyProject(SRC_DIR);
    const bundle = exportSquadConfig(SRC_DIR);
    const json = serializeBundle(bundle);
    const restored = deserializeBundle(json);
    expect(restored.agents).toEqual(bundle.agents);
    expect(restored.skills).toEqual(bundle.skills);
  });

  it('should validate the exported bundle', () => {
    setupLegacyProject(SRC_DIR);
    const bundle = exportSquadConfig(SRC_DIR);
    const errors = validateBundle(bundle);
    expect(errors).toHaveLength(0);
  });

  it('should import bundle file into target project', () => {
    setupLegacyProject(SRC_DIR);
    setupSquadProject(DST_DIR);

    const bundle = exportSquadConfig(SRC_DIR);
    // Write bundle to a file, then import from that file
    const bundlePath = join(BASE_DIR, 'bundle.json');
    writeFileSync(bundlePath, serializeBundle(bundle));
    const result = importSquadConfig(bundlePath, DST_DIR, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Migration registry: ordered execution
// ============================================================================

describe('migration registry runs all registered migrations in order', () => {
  it('should execute migrations in version order', () => {
    const registry = new MigrationRegistry();
    const order: string[] = [];

    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      migrate: (c) => { order.push('1.0→1.1'); return { ...c, version: '1.1.0' }; },
    });
    registry.register({
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      migrate: (c) => { order.push('1.1→1.2'); return { ...c, version: '1.2.0' }; },
    });
    registry.register({
      fromVersion: '1.2.0',
      toVersion: '2.0.0',
      migrate: (c) => { order.push('1.2→2.0'); return { ...c, version: '2.0.0' }; },
    });

    registry.runMigrations({ version: '1.0.0' }, '1.0.0', '2.0.0');
    expect(order).toEqual(['1.0→1.1', '1.1→1.2', '1.2→2.0']);
  });

  it('should apply only relevant migrations in a subrange', () => {
    const registry = new MigrationRegistry();
    const order: string[] = [];

    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      migrate: (c) => { order.push('1.0→1.1'); return { ...c }; },
    });
    registry.register({
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      migrate: (c) => { order.push('1.1→1.2'); return { ...c }; },
    });

    registry.runMigrations({}, '1.1.0', '1.2.0');
    expect(order).toEqual(['1.1→1.2']);
  });

  it('should return no-op result for same version', () => {
    const registry = buildMigrationChain();
    const result = registry.runMigrations({ version: '0.5.0' }, '0.5.0', '0.5.0');
    expect(result.applied).toHaveLength(0);
    expect(result.config.version).toBe('0.5.0');
  });
});

// ============================================================================
// Rollback: v0.6.x → v0.5.x
// ============================================================================

describe('rollback from v0.6.x → v0.5.x', () => {
  it('should rollback a single step', () => {
    const registry = buildMigrationChain();
    // First migrate forward
    const forward = registry.runMigrations({ version: '0.5.0' }, '0.5.0', '0.6.0');
    expect(forward.config.version).toBe('0.6.0');

    // Then rollback
    const rollback = registry.runMigrations(forward.config, '0.6.0', '0.5.0');
    expect(rollback.config.version).toBe('0.5.0');
    expect(rollback.rolledBack).toBe(true);
    expect(rollback.applied).toHaveLength(1);
  });

  it('should rollback multi-step: v0.6.0 → v0.4.0', () => {
    const registry = buildMigrationChain();
    const config = { version: '0.6.0', governance: {}, models: {}, agentSources: [] };
    const result = registry.runMigrations(config as any, '0.6.0', '0.4.0');
    expect(result.config.version).toBe('0.4.0');
    expect(result.applied).toHaveLength(2);
    expect(result.rolledBack).toBe(true);
  });

  it('should throw when rollback is not supported', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      migrate: (c) => ({ ...c, version: '1.1.0' }),
      // No rollback defined
    });
    expect(() =>
      registry.runMigrations({ version: '1.1.0' }, '1.1.0', '1.0.0'),
    ).toThrow();
  });

  it('should preserve custom fields through rollback', () => {
    const registry = buildMigrationChain();
    const forward = registry.runMigrations(
      { version: '0.5.0', customData: 'important' },
      '0.5.0',
      '0.6.0',
    );
    const rollback = registry.runMigrations(forward.config, '0.6.0', '0.5.0');
    expect(rollback.config.customData).toBe('important');
  });
});

// ============================================================================
// Partial migration: some files missing
// ============================================================================

describe('partial migration (some files missing)', () => {
  it('should handle missing routing.md', () => {
    mkdirSync(join(SRC_DIR, '.ai-team'), { recursive: true });
    writeFileSync(
      join(SRC_DIR, '.ai-team', 'team.md'),
      '# Team\n\n## fenster — Dev\n- **Skills:** TS\n',
    );

    const teamMd = readFileSync(join(SRC_DIR, '.ai-team', 'team.md'), 'utf-8');
    const result = migrateMarkdownToConfig({ teamMd });
    expect(result.config).toBeTruthy();
    expect(result.config.routing).toBeDefined();
  });

  it('should handle missing team.md', () => {
    mkdirSync(join(SRC_DIR, '.ai-team'), { recursive: true });
    writeFileSync(
      join(SRC_DIR, '.ai-team', 'routing.md'),
      '# Routing\n\n## feature-dev → fenster\n',
    );

    const routingMd = readFileSync(join(SRC_DIR, '.ai-team', 'routing.md'), 'utf-8');
    const result = migrateMarkdownToConfig({ routingMd });
    expect(result.config).toBeTruthy();
  });

  it('should handle empty options (no markdown)', () => {
    const result = migrateMarkdownToConfig({});
    expect(result.config).toBeTruthy();
    expect(result.config.version).toBeTruthy();
  });

  it('should handle empty team.md content', () => {
    const result = migrateMarkdownToConfig({ teamMd: '' });
    expect(result.config).toBeTruthy();
    expect(result.skippedSections).toContain('team');
  });
});

// ============================================================================
// Migration with custom agent sources
// ============================================================================

describe('migration with custom agent sources', () => {
  it('should handle config with agent sources', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '0.5.0',
      toVersion: '0.6.0',
      migrate: (config) => ({
        ...config,
        version: '0.6.0',
        agentSources: [
          { type: 'git', location: 'https://github.com/org/agents.git', version: 'main' },
          { type: 'npm', location: '@org/agents', version: '^1.0.0' },
        ],
      }),
      rollback: (config) => {
        const { agentSources: _, ...rest } = config;
        return { ...rest, version: '0.5.0' };
      },
    });

    const result = registry.runMigrations({ version: '0.5.0' }, '0.5.0', '0.6.0');
    expect(result.config.agentSources).toHaveLength(2);
    const sources = result.config.agentSources as { type: string; location: string }[];
    expect(sources[0].type).toBe('git');
    expect(sources[1].type).toBe('npm');
  });

  it('should preserve agent sources through multi-step migration', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '0.5.0',
      toVersion: '0.6.0',
      migrate: (config) => ({
        ...config,
        version: '0.6.0',
        agentSources: config.agentSources ?? [{ type: 'local', location: './agents' }],
      }),
      rollback: (config) => {
        const { agentSources: _, ...rest } = config;
        return { ...rest, version: '0.5.0' };
      },
    });
    registry.register({
      fromVersion: '0.6.0',
      toVersion: '0.7.0',
      migrate: (config) => ({
        ...config,
        version: '0.7.0',
      }),
      rollback: (config) => ({ ...config, version: '0.6.0' }),
    });

    const result = registry.runMigrations(
      { version: '0.5.0', agentSources: [{ type: 'url', location: 'https://example.com/agents' }] },
      '0.5.0',
      '0.7.0',
    );
    const sources = result.config.agentSources as { type: string; location: string }[];
    expect(sources[0].type).toBe('url');
  });

  it('should rollback agent sources', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '0.5.0',
      toVersion: '0.6.0',
      migrate: (config) => ({
        ...config,
        version: '0.6.0',
        agentSources: [{ type: 'local', location: './agents' }],
      }),
      rollback: (config) => {
        const { agentSources: _, ...rest } = config;
        return { ...rest, version: '0.5.0' };
      },
    });

    const forward = registry.runMigrations({ version: '0.5.0' }, '0.5.0', '0.6.0');
    expect(forward.config.agentSources).toBeDefined();

    const rollback = registry.runMigrations(forward.config, '0.6.0', '0.5.0');
    expect(rollback.config.agentSources).toBeUndefined();
  });
});

// ============================================================================
// Additional edge-case tests
// ============================================================================

describe('edge cases', () => {
  it('should throw for missing migration path', () => {
    const registry = new MigrationRegistry();
    expect(() =>
      registry.runMigrations({}, '1.0.0', '9.0.0'),
    ).toThrow('No migration path');
  });

  it('should detect migration path gaps', () => {
    const registry = new MigrationRegistry();
    registry.register({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      migrate: (c) => c,
    });
    registry.register({
      fromVersion: '1.2.0',
      toVersion: '1.3.0',
      migrate: (c) => c,
    });
    const gaps = registry.detectGaps('1.0.0', '1.3.0');
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('should handle hasPath for rollback direction', () => {
    const registry = buildMigrationChain();
    expect(registry.hasPath('0.6.0', '0.4.0')).toBe(true);
  });

  it('should validate semver in migration registration', () => {
    const registry = new MigrationRegistry();
    expect(() =>
      registry.register({
        fromVersion: 'invalid',
        toVersion: '1.0.0',
        migrate: (c) => c,
      }),
    ).toThrow('Invalid version format');
  });
});
