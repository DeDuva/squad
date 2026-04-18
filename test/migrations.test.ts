import { describe, it, expect } from 'vitest';
import {
  migration_0_4_to_0_5,
  migration_0_5_to_0_6,
  getRegisteredMigrations,
  createDefaultRegistry,
} from '@squad/sdk/config/migrations';

// ============================================================================
// getRegisteredMigrations
// ============================================================================

describe('getRegisteredMigrations', () => {
  it('should return all known migrations', () => {
    const migrations = getRegisteredMigrations();
    expect(migrations).toHaveLength(2);
  });

  it('should return migrations in version order', () => {
    const migrations = getRegisteredMigrations();
    expect(migrations[0].fromVersion).toBe('0.4.0');
    expect(migrations[0].toVersion).toBe('0.5.0');
    expect(migrations[1].fromVersion).toBe('0.5.0');
    expect(migrations[1].toVersion).toBe('0.6.0');
  });

  it('should return immutable array (no shared state)', () => {
    const a = getRegisteredMigrations();
    const b = getRegisteredMigrations();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// createDefaultRegistry
// ============================================================================

describe('createDefaultRegistry', () => {
  it('should return a registry pre-loaded with all migrations', () => {
    const registry = createDefaultRegistry();
    const list = registry.list();
    expect(list).toHaveLength(2);
  });

  it('should support full path from 0.4.0 to 0.6.0', () => {
    const registry = createDefaultRegistry();
    expect(registry.hasPath('0.4.0', '0.6.0')).toBe(true);
  });

  it('should support rollback from 0.6.0 to 0.4.0', () => {
    const registry = createDefaultRegistry();
    expect(registry.hasPath('0.6.0', '0.4.0')).toBe(true);
  });

  it('should run full forward migration chain 0.4.0 → 0.6.0', () => {
    const registry = createDefaultRegistry();
    const config = { version: '0.4.0', configDir: '.ai-team' };
    const result = registry.runMigrations(config, '0.4.0', '0.6.0');

    expect(result.config.version).toBe('0.6.0');
    expect(result.applied).toHaveLength(2);
    expect(result.rolledBack).toBe(false);
  });

  it('should run full rollback chain 0.6.0 → 0.4.0', () => {
    const registry = createDefaultRegistry();
    const config = {
      version: '0.6.0',
      configDir: '.squad',
      agents: [{ name: '@keaton', role: 'lead', displayName: 'Keaton' }],
      routing: { rules: [], fallbackBehavior: 'coordinator' },
      models: { default: 'claude-sonnet-4', defaultTier: 'standard', tiers: {} },
      agentSources: [{ type: 'local', name: 'local', path: '.squad/agents' }],
      configFormat: 'squad.config.ts',
    };

    const result = registry.runMigrations(config, '0.6.0', '0.4.0');
    expect(result.config.version).toBe('0.4.0');
    expect(result.applied).toHaveLength(2);
    expect(result.rolledBack).toBe(true);
  });
});

// ============================================================================
// Migration 0.4.x → 0.5.x
// ============================================================================

describe('migration 0.4.0 → 0.5.0', () => {
  it('should update version to 0.5.0', () => {
    const result = migration_0_4_to_0_5.migrate({ version: '0.4.0' });
    expect(result.version).toBe('0.5.0');
  });

  it('should rename .ai-team → .squad in configDir', () => {
    const result = migration_0_4_to_0_5.migrate({ configDir: '.ai-team' });
    expect(result.configDir).toBe('.squad');
  });

  it('should convert teamMembers to agents array', () => {
    const config = {
      version: '0.4.0',
      teamMembers: [
        { name: 'Keaton', role: 'Lead', model: 'claude-opus-4.5' },
        { name: 'Harper', role: 'Developer' },
      ],
    };
    const result = migration_0_4_to_0_5.migrate(config);

    expect(result.agents).toBeInstanceOf(Array);
    const agents = result.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe('@keaton');
    expect(agents[0].role).toBe('Lead');
    expect(agents[0].model).toBe('claude-opus-4.5');
    expect(agents[1].name).toBe('@harper');
    expect(result.teamMembers).toBeUndefined();
  });

  it('should set configFormat to squad.config.ts', () => {
    const result = migration_0_4_to_0_5.migrate({ version: '0.4.0' });
    expect(result.configFormat).toBe('squad.config.ts');
  });

  it('should rename .ai-team in agentDir', () => {
    const result = migration_0_4_to_0_5.migrate({ agentDir: '.ai-team/agents' });
    expect(result.agentDir).toBe('.squad/agents');
  });

  it('should rollback version to 0.4.0', () => {
    const result = migration_0_4_to_0_5.rollback!({ version: '0.5.0', configFormat: 'squad.config.ts' });
    expect(result.version).toBe('0.4.0');
    expect(result.configFormat).toBeUndefined();
  });

  it('should rollback agents → teamMembers', () => {
    const config = {
      version: '0.5.0',
      agents: [{ name: '@keaton', role: 'lead', displayName: 'Keaton' }],
    };
    const result = migration_0_4_to_0_5.rollback!(config);

    expect(result.teamMembers).toBeInstanceOf(Array);
    expect(result.agents).toBeUndefined();
    const members = result.teamMembers as Array<Record<string, unknown>>;
    expect(members[0].name).toBe('Keaton');
  });

  it('should rollback .squad → .ai-team in configDir', () => {
    const result = migration_0_4_to_0_5.rollback!({ configDir: '.squad' });
    expect(result.configDir).toBe('.ai-team');
  });
});

// ============================================================================
// Migration 0.5.x → 0.6.x
// ============================================================================

describe('migration 0.5.0 → 0.6.0', () => {
  it('should update version to 0.6.0', () => {
    const result = migration_0_5_to_0_6.migrate({ version: '0.5.0' });
    expect(result.version).toBe('0.6.0');
  });

  it('should convert string routing rules to typed objects', () => {
    const config = {
      version: '0.5.0',
      routing: { rules: ['feature-dev → Lead', 'bug-fix → Developer'] },
    };
    const result = migration_0_5_to_0_6.migrate(config);
    const routing = result.routing as Record<string, unknown>;
    const rules = routing.rules as Array<Record<string, unknown>>;

    expect(rules).toHaveLength(2);
    expect(rules[0].pattern).toBe('feature-dev');
    expect(rules[0].agents).toEqual(['@lead']);
    expect(rules[0].tier).toBe('standard');
  });

  it('should add fallbackBehavior to routing', () => {
    const config = { version: '0.5.0', routing: { rules: [] } };
    const result = migration_0_5_to_0_6.migrate(config);
    const routing = result.routing as Record<string, unknown>;
    expect(routing.fallbackBehavior).toBe('coordinator');
  });

  it('should add model registry with tier system', () => {
    const result = migration_0_5_to_0_6.migrate({ version: '0.5.0' });
    const models = result.models as Record<string, unknown>;
    expect(models.defaultTier).toBe('standard');
    expect(models.tiers).toBeDefined();
  });

  it('should preserve existing model config and add defaults', () => {
    const config = { version: '0.5.0', models: { default: 'gpt-5.1-codex' } };
    const result = migration_0_5_to_0_6.migrate(config);
    const models = result.models as Record<string, unknown>;
    expect(models.default).toBe('gpt-5.1-codex');
    expect(models.defaultTier).toBe('standard');
  });

  it('should add agent sources', () => {
    const result = migration_0_5_to_0_6.migrate({ version: '0.5.0' });
    expect(result.agentSources).toBeDefined();
    const sources = result.agentSources as Array<Record<string, unknown>>;
    expect(sources[0].type).toBe('local');
  });

  it('should add tier to existing object routing rules missing it', () => {
    const config = {
      version: '0.5.0',
      routing: { rules: [{ pattern: 'docs', agents: ['@scribe'] }] },
    };
    const result = migration_0_5_to_0_6.migrate(config);
    const rules = (result.routing as Record<string, unknown>).rules as Array<Record<string, unknown>>;
    expect(rules[0].tier).toBe('standard');
  });

  it('should create default routing when missing', () => {
    const result = migration_0_5_to_0_6.migrate({ version: '0.5.0' });
    const routing = result.routing as Record<string, unknown>;
    expect(routing.rules).toEqual([]);
    expect(routing.fallbackBehavior).toBe('coordinator');
  });

  it('should rollback version to 0.5.0', () => {
    const result = migration_0_5_to_0_6.rollback!({ version: '0.6.0' });
    expect(result.version).toBe('0.5.0');
  });

  it('should rollback typed routing to simple format', () => {
    const config = {
      version: '0.6.0',
      routing: {
        rules: [{ pattern: 'feature-dev', agents: ['@lead'], tier: 'standard' }],
        fallbackBehavior: 'coordinator',
      },
    };
    const result = migration_0_5_to_0_6.rollback!(config);
    const routing = result.routing as Record<string, unknown>;
    const rules = routing.rules as string[];
    expect(rules[0]).toBe('feature-dev → @lead');
    expect(routing.fallbackBehavior).toBeUndefined();
  });

  it('should remove agent sources on rollback', () => {
    const config = {
      version: '0.6.0',
      agentSources: [{ type: 'local' }],
    };
    const result = migration_0_5_to_0_6.rollback!(config);
    expect(result.agentSources).toBeUndefined();
  });

  it('should remove tier system on rollback', () => {
    const config = {
      version: '0.6.0',
      models: { default: 'claude-sonnet-4', defaultTier: 'standard', tiers: {} },
    };
    const result = migration_0_5_to_0_6.rollback!(config);
    const models = result.models as Record<string, unknown>;
    expect(models.defaultTier).toBeUndefined();
    expect(models.tiers).toBeUndefined();
    expect(models.default).toBe('claude-sonnet-4');
  });
});
