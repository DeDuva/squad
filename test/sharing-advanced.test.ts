/**
 * Advanced sharing tests: versioning, agent-repo, cache, conflicts
 * (M5-6 #129, M5-7 #131, M5-8 #132, M5-9 #133)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pinAgentVersion,
  resolveVersion,
  compareAgentVersions,
  getVersionHistory,
  clearVersionStore,
  type VersionPin,
  type AgentVersionResolver,
} from '@deduvafork/squad-sdk/sharing';
import {
  configureAgentRepo,
  listRepoAgents,
  pullAgent,
  pushAgent,
  type AgentRepoConfig,
  type AgentRepoOperations,
} from '@deduvafork/squad-sdk/sharing';
import {
  AgentCache,
  DEFAULT_AGENT_TTL,
  DEFAULT_SKILL_TTL,
  type CacheEntry,
  type CacheStats,
} from '@deduvafork/squad-sdk/sharing';
import {
  detectConflicts,
  resolveConflicts,
  generateConflictReport,
  type IncomingBundle,
  type Conflict,
  type ConflictStrategy,
} from '@deduvafork/squad-sdk/sharing';
import type { AgentDefinition } from '@deduvafork/squad-sdk/config';
import type { SquadConfig } from '@deduvafork/squad-sdk/config';

// ===== Helpers =====

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: overrides.name ?? 'test-agent',
    role: overrides.role ?? 'tester',
    source: overrides.source ?? 'local',
    charter: overrides.charter ?? '# Test Agent\nA test agent.',
    model: overrides.model,
    tools: overrides.tools,
    skills: overrides.skills,
    history: overrides.history,
  };
}

function makeConfig(overrides: Partial<SquadConfig> = {}): SquadConfig {
  return {
    version: overrides.version ?? '0.6.0',
    team: overrides.team ?? { name: 'Test Squad', description: 'A test squad' },
    routing: overrides.routing ?? { rules: [], fallbackBehavior: 'coordinator' },
    models: overrides.models ?? {
      default: 'claude-sonnet-4',
      defaultTier: 'standard',
      tiers: { standard: ['claude-sonnet-4'], fast: ['claude-haiku-4.5'] },
    },
    agents: overrides.agents ?? [{ name: 'verbal', role: 'prompt-engineer' }],
  };
}

function makeOps(
  dirs: Array<{ name: string; type: 'file' | 'dir' }> = [],
  files: Record<string, string> = {},
): AgentRepoOperations {
  return {
    listDirectory: vi.fn(async () => dirs),
    getFileContent: vi.fn(async (_o, _r, p) => files[p] ?? null),
    pushFile: vi.fn(async () => ({ sha: 'abc123' })),
  };
}

const CHARTER = `## Identity
**Name:** TestBot
**Role:** Test Runner

## Tools
- vitest
`;

// ======================
// M5-6: Versioning Tests
// ======================

describe('Versioning (M5-6)', () => {
  beforeEach(() => {
    clearVersionStore();
  });

  describe('pinAgentVersion', () => {
    it('should create a version pin with correct fields', () => {
      const pin = pinAgentVersion('verbal', 'abc123');
      expect(pin.agentId).toBe('verbal');
      expect(pin.sha).toBe('abc123');
      expect(pin.source).toBe('local');
      expect(typeof pin.timestamp).toBe('number');
    });

    it('should store pin in version history', () => {
      pinAgentVersion('verbal', 'sha1');
      pinAgentVersion('verbal', 'sha2');
      const history = getVersionHistory('verbal');
      expect(history).toHaveLength(2);
    });

    it('should support github source', () => {
      const pin = pinAgentVersion('verbal', 'abc', 'github');
      expect(pin.source).toBe('github');
    });

    it('should support "latest" as special SHA', () => {
      const pin = pinAgentVersion('verbal', 'latest');
      expect(pin.sha).toBe('latest');
    });
  });

  describe('getVersionHistory', () => {
    it('should return empty array for unknown agent', () => {
      expect(getVersionHistory('unknown')).toEqual([]);
    });

    it('should return pins in chronological order', () => {
      pinAgentVersion('a', 'sha1');
      pinAgentVersion('a', 'sha2');
      const history = getVersionHistory('a');
      expect(history[0].sha).toBe('sha1');
      expect(history[1].sha).toBe('sha2');
    });

    it('should return a copy (not mutable reference)', () => {
      pinAgentVersion('a', 'sha1');
      const h1 = getVersionHistory('a');
      h1.push({ agentId: 'a', sha: 'fake', timestamp: 0, source: 'local' });
      expect(getVersionHistory('a')).toHaveLength(1);
    });
  });

  describe('resolveVersion', () => {
    it('should resolve a pinned version via resolver', async () => {
      const agent = makeAgent({ name: 'verbal' });
      const resolver: AgentVersionResolver = vi.fn(async () => agent);
      const pin = pinAgentVersion('verbal', 'abc123');

      const result = await resolveVersion(pin, resolver);
      expect(result).toBe(agent);
      expect(resolver).toHaveBeenCalledWith('verbal', 'abc123');
    });

    it('should resolve "latest" via headResolver', async () => {
      const agent = makeAgent({ name: 'verbal' });
      const resolver: AgentVersionResolver = vi.fn(async () => agent);
      const headResolver = vi.fn(async () => 'head-sha');
      const pin = pinAgentVersion('verbal', 'latest');

      const result = await resolveVersion(pin, resolver, headResolver);
      expect(result).toBe(agent);
      expect(headResolver).toHaveBeenCalledWith('verbal');
      expect(resolver).toHaveBeenCalledWith('verbal', 'head-sha');
    });

    it('should return null for "latest" without headResolver', async () => {
      const resolver: AgentVersionResolver = vi.fn(async () => null);
      const pin = pinAgentVersion('verbal', 'latest');

      const result = await resolveVersion(pin, resolver);
      expect(result).toBeNull();
    });
  });

  describe('compareAgentVersions', () => {
    it('should detect changed fields between versions', async () => {
      const agentA = makeAgent({ name: 'verbal', role: 'prompter', charter: 'v1' });
      const agentB = makeAgent({ name: 'verbal', role: 'engineer', charter: 'v2' });
      const resolver: AgentVersionResolver = vi.fn(async (_id, sha) =>
        sha === 'sha1' ? agentA : agentB,
      );
      const pinA: VersionPin = { agentId: 'verbal', sha: 'sha1', timestamp: 1, source: 'local' };
      const pinB: VersionPin = { agentId: 'verbal', sha: 'sha2', timestamp: 2, source: 'local' };

      const diff = await compareAgentVersions(pinA, pinB, resolver);
      expect(diff.fields).toContain('role');
      expect(diff.fields).toContain('charter');
      expect(diff.agentId).toBe('verbal');
    });

    it('should return __unresolvable__ when agents cannot be resolved', async () => {
      const resolver: AgentVersionResolver = vi.fn(async () => null);
      const pinA: VersionPin = { agentId: 'x', sha: 'sha1', timestamp: 1, source: 'local' };
      const pinB: VersionPin = { agentId: 'x', sha: 'sha2', timestamp: 2, source: 'local' };

      const diff = await compareAgentVersions(pinA, pinB, resolver);
      expect(diff.fields).toContain('__unresolvable__');
    });

    it('should detect tool changes', async () => {
      const agentA = makeAgent({ tools: ['edit'] });
      const agentB = makeAgent({ tools: ['edit', 'grep'] });
      const resolver: AgentVersionResolver = vi.fn(async (_id, sha) =>
        sha === 'a' ? agentA : agentB,
      );
      const pinA: VersionPin = { agentId: 't', sha: 'a', timestamp: 1, source: 'local' };
      const pinB: VersionPin = { agentId: 't', sha: 'b', timestamp: 2, source: 'local' };

      const diff = await compareAgentVersions(pinA, pinB, resolver);
      expect(diff.fields).toContain('tools');
    });
  });

  describe('clearVersionStore', () => {
    it('should remove all stored versions', () => {
      pinAgentVersion('a', 'sha1');
      pinAgentVersion('b', 'sha2');
      clearVersionStore();
      expect(getVersionHistory('a')).toHaveLength(0);
      expect(getVersionHistory('b')).toHaveLength(0);
    });
  });
});

// ========================
// M5-7: Agent Repo Tests
// ========================

describe('Agent Repo (M5-7)', () => {
  describe('configureAgentRepo', () => {
    it('should validate and return config with defaults', () => {
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad-team' });
      expect(config.owner).toBe('acme');
      expect(config.repo).toBe('squad-team');
      expect(config.branch).toBe('main');
      expect(config.path).toBe('.squad/agents');
    });

    it('should preserve custom branch and path', () => {
      const config = configureAgentRepo({
        owner: 'acme',
        repo: 'squad',
        branch: 'develop',
        path: 'custom/agents',
      });
      expect(config.branch).toBe('develop');
      expect(config.path).toBe('custom/agents');
    });

    it('should throw on missing owner', () => {
      expect(() => configureAgentRepo({ owner: '', repo: 'x' })).toThrow('owner is required');
    });

    it('should throw on missing repo', () => {
      expect(() => configureAgentRepo({ owner: 'x', repo: '' })).toThrow('repo is required');
    });

    it('should preserve authentication config', () => {
      const config = configureAgentRepo({
        owner: 'acme',
        repo: 'squad',
        authentication: { type: 'token', token: 'ghp_xxx' },
      });
      expect(config.authentication?.type).toBe('token');
    });
  });

  describe('listRepoAgents', () => {
    it('should list agents from repo', async () => {
      const ops = makeOps(
        [{ name: 'verbal', type: 'dir' }, { name: 'fenster', type: 'dir' }],
        {
          '.squad/agents/verbal/charter.md': CHARTER,
          '.squad/agents/fenster/charter.md': '## Identity\n**Name:** Fenster\n**Role:** Architect',
        },
      );
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });

      const agents = await listRepoAgents(config, ops);
      expect(agents).toHaveLength(2);
      expect(agents[0].source).toContain('github:acme/squad');
    });

    it('should return empty for no agents', async () => {
      const ops = makeOps([], {});
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });

      const agents = await listRepoAgents(config, ops);
      expect(agents).toHaveLength(0);
    });
  });

  describe('pullAgent', () => {
    it('should pull agent definition from repo', async () => {
      const ops = makeOps([], {
        '.squad/agents/testbot/charter.md': CHARTER,
      });
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });

      const agent = await pullAgent(config, 'testbot', ops);
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('TestBot');
      expect(agent!.role).toBe('Test Runner');
      expect(agent!.charter).toBe(CHARTER);
    });

    it('should include history when available', async () => {
      const ops = makeOps([], {
        '.squad/agents/testbot/charter.md': CHARTER,
        '.squad/agents/testbot/history.md': '# History',
      });
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });

      const agent = await pullAgent(config, 'testbot', ops);
      expect(agent!.history).toBe('# History');
    });

    it('should return null for missing agent', async () => {
      const ops = makeOps([], {});
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });

      const agent = await pullAgent(config, 'missing', ops);
      expect(agent).toBeNull();
    });
  });

  describe('pushAgent', () => {
    it('should push agent charter to repo', async () => {
      const ops = makeOps();
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });
      const agent = makeAgent({ name: 'verbal', charter: '# Verbal charter' });

      const result = await pushAgent(config, agent, ops);
      expect(result.success).toBe(true);
      expect(result.sha).toBe('abc123');
      expect(result.errors).toHaveLength(0);
    });

    it('should return errors on push failure', async () => {
      const ops = makeOps();
      ops.pushFile = vi.fn(async () => { throw new Error('Permission denied'); });
      const config = configureAgentRepo({ owner: 'acme', repo: 'squad' });
      const agent = makeAgent();

      const result = await pushAgent(config, agent, ops);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Permission denied');
    });
  });
});

// ====================
// M5-8: Cache Tests
// ====================

describe('AgentCache (M5-8)', () => {
  it('should return null for missing keys', () => {
    const cache = new AgentCache();
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('should store and retrieve values', () => {
    const cache = new AgentCache();
    const agent = makeAgent({ name: 'cached-agent' });
    cache.set('agent-1', agent);

    const retrieved = cache.get('agent-1');
    expect(retrieved).toEqual(agent);
  });

  it('should track hit and miss stats', () => {
    const cache = new AgentCache();
    cache.get('miss1');
    cache.get('miss2');
    cache.set('hit', makeAgent());
    cache.get('hit');

    const stats = cache.getStats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('should invalidate entries', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent());
    expect(cache.invalidate('a')).toBe(true);
    expect(cache.get('a')).toBeNull();
    expect(cache.getStats().evictions).toBe(1);
  });

  it('should return false when invalidating non-existent key', () => {
    const cache = new AgentCache();
    expect(cache.invalidate('x')).toBe(false);
  });

  it('should clear all entries', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent());
    cache.set('b', makeAgent());
    cache.clear();

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });

  it('should evict expired entries on get', () => {
    const cache = new AgentCache(1); // 1ms TTL
    cache.set('expire', makeAgent());

    // Force expiration
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('expire')).toBeNull();
        expect(cache.getStats().evictions).toBe(1);
        resolve();
      }, 10);
    });
  });

  it('should respect custom TTL per entry', () => {
    const cache = new AgentCache(60_000);
    cache.set('long', makeAgent(), 120_000);
    cache.set('short', makeAgent(), 1);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('long')).not.toBeNull();
        expect(cache.get('short')).toBeNull();
        resolve();
      }, 10);
    });
  });

  it('should check has() correctly', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent());
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('should list non-expired entries', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent());
    cache.set('b', makeAgent());
    const entries = cache.entries();
    expect(entries).toHaveLength(2);
  });

  it('should have correct default TTL constants', () => {
    expect(DEFAULT_AGENT_TTL).toBe(60 * 60 * 1000);
    expect(DEFAULT_SKILL_TTL).toBe(5 * 60 * 1000);
  });

  it('should work with generic types', () => {
    const cache = new AgentCache<string>(60_000);
    cache.set('key', 'string-value');
    expect(cache.get('key')).toBe('string-value');
  });

  it('should track evictions on clear correctly', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent());
    cache.set('b', makeAgent());
    cache.clear();

    const stats = cache.getStats();
    expect(stats.evictions).toBe(2);
  });

  it('should record source in cache entries', () => {
    const cache = new AgentCache();
    cache.set('a', makeAgent(), undefined, 'github');
    const entries = cache.entries();
    expect(entries[0][1].source).toBe('github');
  });
});

// =========================
// M5-9: Conflict Tests
// =========================

describe('Conflict Resolution (M5-9)', () => {
  const baseConfig = makeConfig();

  describe('detectConflicts', () => {
    it('should detect no conflicts for identical config', () => {
      const incoming: IncomingBundle = {
        version: '0.6.0',
        config: { ...baseConfig },
      };
      const conflicts = detectConflicts(baseConfig, incoming);
      expect(conflicts).toHaveLength(0);
    });

    it('should detect added fields', () => {
      const incoming: IncomingBundle = {
        version: '0.6.0',
        config: { ...baseConfig, hooks: { scrubPii: true } } as Partial<SquadConfig>,
      };
      const conflicts = detectConflicts(
        makeConfig({ hooks: undefined }),
        incoming,
      );
      const added = conflicts.filter(c => c.type === 'added');
      expect(added.length).toBeGreaterThan(0);
    });

    it('should detect modified fields', () => {
      const incoming: IncomingBundle = {
        version: '0.6.0',
        config: { ...baseConfig, version: '1.0.0' },
      };
      const conflicts = detectConflicts(baseConfig, incoming);
      const modified = conflicts.filter(c => c.type === 'modified');
      expect(modified.length).toBeGreaterThan(0);
      expect(modified.some(c => c.path === 'version')).toBe(true);
    });

    it('should detect removed fields', () => {
      const existing = makeConfig({ hooks: { scrubPii: true } });
      const incoming: IncomingBundle = {
        version: '0.6.0',
        config: { version: '0.6.0' },
      };
      const conflicts = detectConflicts(existing, incoming);
      const removed = conflicts.filter(c => c.type === 'removed');
      expect(removed.length).toBeGreaterThan(0);
    });

    it('should use dotted paths for nested fields', () => {
      const incoming: IncomingBundle = {
        version: '0.6.0',
        config: { ...baseConfig, team: { name: 'New Name' } },
      };
      const conflicts = detectConflicts(baseConfig, incoming);
      const teamConflict = conflicts.find(c => c.path === 'team.name');
      expect(teamConflict).toBeDefined();
    });
  });

  describe('resolveConflicts', () => {
    it('keep-existing should return existing config unchanged', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
      ];
      const result = resolveConflicts(baseConfig, conflicts, 'keep-existing');
      expect(result.version).toBe('0.6.0');
    });

    it('use-incoming should apply all incoming values', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
      ];
      const result = resolveConflicts(baseConfig, conflicts, 'use-incoming');
      expect(result.version).toBe('1.0.0');
    });

    it('use-incoming should delete removed fields', () => {
      const existing = makeConfig();
      const conflicts: Conflict[] = [
        { path: 'team.description', existingValue: 'A test squad', incomingValue: undefined, type: 'removed' },
      ];
      const result = resolveConflicts(existing, conflicts, 'use-incoming');
      expect(result.team.description).toBeUndefined();
    });

    it('merge should add new fields but keep existing on conflicts', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
        { path: 'team.projectContext', existingValue: undefined, incomingValue: 'New context', type: 'added' },
      ];
      const result = resolveConflicts(baseConfig, conflicts, 'merge');
      expect(result.version).toBe('0.6.0'); // kept existing
      expect(result.team.projectContext).toBe('New context'); // added new
    });

    it('manual should return existing config unchanged', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
      ];
      const result = resolveConflicts(baseConfig, conflicts, 'manual');
      expect(result.version).toBe('0.6.0');
    });
  });

  describe('generateConflictReport', () => {
    it('should report no conflicts', () => {
      const report = generateConflictReport([]);
      expect(report).toContain('No conflicts detected');
    });

    it('should generate markdown table for conflicts', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
        { path: 'team.description', existingValue: undefined, incomingValue: 'New desc', type: 'added' },
      ];
      const report = generateConflictReport(conflicts);
      expect(report).toContain('# Conflict Report');
      expect(report).toContain('**2** conflict(s)');
      expect(report).toContain('`version`');
      expect(report).toContain('modified');
      expect(report).toContain('added');
    });

    it('should show _(none)_ for undefined values', () => {
      const conflicts: Conflict[] = [
        { path: 'hooks.scrubPii', existingValue: undefined, incomingValue: true, type: 'added' },
      ];
      const report = generateConflictReport(conflicts);
      expect(report).toContain('_(none)_');
    });

    it('should include table headers', () => {
      const conflicts: Conflict[] = [
        { path: 'version', existingValue: '0.6.0', incomingValue: '1.0.0', type: 'modified' },
      ];
      const report = generateConflictReport(conflicts);
      expect(report).toContain('Path');
      expect(report).toContain('Type');
      expect(report).toContain('Existing');
      expect(report).toContain('Incoming');
    });
  });
});
