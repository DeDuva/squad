/**
 * Tests for agent-doc parser and doc-sync (M2-12)
 */

import { describe, it, expect } from 'vitest';
import {
  parseAgentDoc,
  type AgentDocMetadata,
} from '@squad/sdk/config';
import {
  syncDocToConfig,
  syncConfigToDoc,
  detectDrift,
  type DriftReport,
} from '@squad/sdk/config';
import { defineConfig, type SquadConfig } from '@squad/sdk/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config factory — always supplies a fresh agents array. */
function makeConfig(overrides: Partial<SquadConfig> = {}): SquadConfig {
  return defineConfig({ agents: [], ...overrides });
}

/** Full-featured agent doc used by many tests. */
const FULL_DOC = `
# Coordinator

## Identity

**Name:** Coordinator
**Role:** Team coordinator
**Model:** claude-sonnet-4.5

## Capabilities

- Route tasks to specialists
- Decompose complex requests
- Maintain team context

## Routing

- feature-dev
- bug-fix
- documentation

## Constraints

- Never commit secrets
- Always run tests before merging

## Tools

- grep
- edit
- create
`.trim();

// ============================================================================
// parseAgentDoc
// ============================================================================

describe('parseAgentDoc', () => {
  // --- basic parsing ---------------------------------------------------

  it('should extract name from H1 heading', () => {
    const meta = parseAgentDoc('# My Agent\n\nSome text');
    expect(meta.name).toBe('My Agent');
  });

  it('should extract identity fields', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.name).toBe('Coordinator');
    expect(meta.description).toBe('Team coordinator');
  });

  it('should extract capabilities', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.capabilities).toHaveLength(3);
    expect(meta.capabilities).toContain('Route tasks to specialists');
    expect(meta.capabilities).toContain('Decompose complex requests');
  });

  it('should extract routing hints', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.routingHints).toEqual(['feature-dev', 'bug-fix', 'documentation']);
  });

  it('should extract model preferences', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.modelPreferences).toContain('claude-sonnet-4.5');
  });

  it('should extract constraints', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.constraints).toHaveLength(2);
    expect(meta.constraints[0]).toBe('Never commit secrets');
  });

  it('should extract tools', () => {
    const meta = parseAgentDoc(FULL_DOC);
    expect(meta.tools).toEqual(['grep', 'edit', 'create']);
  });

  // --- edge cases -------------------------------------------------------

  it('should return empty metadata for empty input', () => {
    const meta = parseAgentDoc('');
    expect(meta.name).toBeUndefined();
    expect(meta.capabilities).toEqual([]);
    expect(meta.tools).toEqual([]);
  });

  it('should return empty metadata for whitespace-only input', () => {
    const meta = parseAgentDoc('   \n\n  ');
    expect(meta.capabilities).toEqual([]);
  });

  it('should handle doc with only an H1 and no sections', () => {
    const meta = parseAgentDoc('# Solo Agent');
    expect(meta.name).toBe('Solo Agent');
    expect(meta.capabilities).toEqual([]);
    expect(meta.routingHints).toEqual([]);
  });

  it('should capture extra (non-standard) sections', () => {
    const doc = `# Agent\n\n## Identity\n\n**Name:** A\n\n## Custom Section\n\nHello world`;
    const meta = parseAgentDoc(doc);
    expect(meta.extraSections).toHaveProperty('Custom Section');
    expect(meta.extraSections['Custom Section']).toContain('Hello world');
  });

  it('should handle sections with empty bodies', () => {
    const doc = `# Agent\n\n## Capabilities\n\n## Tools\n\n- hammer`;
    const meta = parseAgentDoc(doc);
    expect(meta.capabilities).toEqual([]);
    expect(meta.tools).toEqual(['hammer']);
  });

  it('should handle bullet items using asterisk (*) syntax', () => {
    const doc = `# Agent\n\n## Capabilities\n\n* Alpha\n* Beta`;
    const meta = parseAgentDoc(doc);
    expect(meta.capabilities).toEqual(['Alpha', 'Beta']);
  });

  it('should handle case-insensitive section headings', () => {
    const doc = `# Agent\n\n## IDENTITY\n\n**Name:** Caps\n\n## TOOLS\n\n- wrench`;
    const meta = parseAgentDoc(doc);
    expect(meta.name).toBe('Caps');
    expect(meta.tools).toEqual(['wrench']);
  });

  it('should handle model prefs with multiple comma-separated models', () => {
    const doc = `# Agent\n\n## Identity\n\n**Model:** claude-opus-4, gpt-5.1-codex`;
    const meta = parseAgentDoc(doc);
    expect(meta.modelPreferences).toEqual(['claude-opus-4', 'gpt-5.1-codex']);
  });

  it('should not duplicate model preferences', () => {
    const doc = `# Agent\n\n## Identity\n\n**Model:** claude-sonnet-4\n\n## Routing\n\n**Model:** claude-sonnet-4`;
    const meta = parseAgentDoc(doc);
    expect(meta.modelPreferences).toEqual(['claude-sonnet-4']);
  });
});

// ============================================================================
// syncDocToConfig
// ============================================================================

describe('syncDocToConfig', () => {
  it('should update team name from doc', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig();
    syncDocToConfig(doc, config);
    expect(config.team.name).toBe('Coordinator');
  });

  it('should update team description from doc', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig();
    syncDocToConfig(doc, config);
    expect(config.team.description).toBe('Team coordinator');
  });

  it('should set default model from doc preferences', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig();
    syncDocToConfig(doc, config);
    expect(config.models.default).toBe('claude-sonnet-4.5');
  });

  it('should add routing hints as rules without duplicates', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      routing: { rules: [{ pattern: 'feature-dev', agents: ['@lead'] }] },
    });
    syncDocToConfig(doc, config);
    const patterns = config.routing.rules.map((r) => r.pattern);
    expect(patterns).toContain('feature-dev');
    expect(patterns).toContain('bug-fix');
    // feature-dev should not be duplicated
    expect(patterns.filter((p) => p === 'feature-dev')).toHaveLength(1);
  });

  it('should create a stub agent when config has none', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({ agents: [] });
    syncDocToConfig(doc, config);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe('Coordinator');
    expect(config.agents[0].tools).toEqual(['grep', 'edit', 'create']);
  });

  it('should update first agent tools when agents exist', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      agents: [{ name: 'existing', role: 'dev' }],
    });
    syncDocToConfig(doc, config);
    expect(config.agents[0].tools).toEqual(['grep', 'edit', 'create']);
  });

  it('should not crash on empty doc metadata', () => {
    const doc = parseAgentDoc('');
    const config = makeConfig();
    const updated = syncDocToConfig(doc, config);
    expect(updated).toBeDefined();
    expect(updated.team.name).toBe('Default Squad'); // unchanged
  });
});

// ============================================================================
// syncConfigToDoc
// ============================================================================

describe('syncConfigToDoc', () => {
  it('should generate markdown with all standard sections', () => {
    const config = makeConfig({
      team: { name: 'Test Squad', description: 'Test team' },
      agents: [{ name: 'tester', role: 'QA', tools: ['grep'] }],
    });
    const md = syncConfigToDoc(config);
    expect(md).toContain('# Test Squad');
    expect(md).toContain('## Identity');
    expect(md).toContain('## Capabilities');
    expect(md).toContain('## Routing');
    expect(md).toContain('## Constraints');
    expect(md).toContain('## Tools');
  });

  it('should include team name and description in identity', () => {
    const config = makeConfig({
      team: { name: 'Alpha', description: 'First team' },
    });
    const md = syncConfigToDoc(config);
    expect(md).toContain('**Name:** Alpha');
    expect(md).toContain('**Description:** First team');
  });

  it('should list tools from agents', () => {
    const config = makeConfig({
      agents: [{ name: 'a', role: 'r', tools: ['grep', 'edit'] }],
    });
    const md = syncConfigToDoc(config);
    expect(md).toContain('- grep');
    expect(md).toContain('- edit');
  });

  it('should substitute placeholders in a template', () => {
    const config = makeConfig({
      team: { name: 'TPL', description: 'Template test' },
    });
    const tpl = `# Doc\n\n{{IDENTITY}}\n\n{{CAPABILITIES}}\n\n{{ROUTING}}\n\n{{CONSTRAINTS}}\n\n{{TOOLS}}`;
    const md = syncConfigToDoc(config, tpl);
    expect(md).toContain('**Name:** TPL');
    expect(md).not.toContain('{{IDENTITY}}');
  });

  it('should handle config with no agents gracefully', () => {
    const config = makeConfig({ agents: [] });
    const md = syncConfigToDoc(config);
    expect(md).toContain('_No capabilities defined._');
    expect(md).toContain('_No tools defined._');
  });
});

// ============================================================================
// detectDrift
// ============================================================================

describe('detectDrift', () => {
  it('should report inSync when doc matches config', () => {
    const config = makeConfig({
      team: { name: 'Coordinator', description: 'Team coordinator' },
      models: {
        default: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        tiers: { premium: [], standard: [], fast: [] },
      },
      routing: {
        rules: [
          { pattern: 'feature-dev', agents: [] },
          { pattern: 'bug-fix', agents: [] },
          { pattern: 'documentation', agents: [] },
        ],
      },
      agents: [{ name: 'c', role: 'r', tools: ['grep', 'edit', 'create'] }],
    });
    const doc = parseAgentDoc(FULL_DOC);
    const report = detectDrift(doc, config);
    expect(report.inSync).toBe(true);
    expect(report.entries).toHaveLength(0);
  });

  it('should detect team name drift', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({ team: { name: 'Different' } });
    const report = detectDrift(doc, config);
    expect(report.inSync).toBe(false);
    const nameEntry = report.entries.find((e) => e.field === 'team.name');
    expect(nameEntry).toBeDefined();
    expect(nameEntry!.docValue).toBe('Coordinator');
    expect(nameEntry!.configValue).toBe('Different');
  });

  it('should detect description drift', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      team: { name: 'Coordinator', description: 'Old desc' },
    });
    const report = detectDrift(doc, config);
    const entry = report.entries.find((e) => e.field === 'team.description');
    expect(entry).toBeDefined();
  });

  it('should detect model drift', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      team: { name: 'Coordinator', description: 'Team coordinator' },
      models: {
        default: 'gpt-5.1',
        defaultTier: 'standard',
        tiers: { premium: [], standard: [], fast: [] },
      },
    });
    const report = detectDrift(doc, config);
    const entry = report.entries.find((e) => e.field === 'models.default');
    expect(entry).toBeDefined();
    expect(entry!.docValue).toBe('claude-sonnet-4.5');
  });

  it('should detect missing routing rules', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      team: { name: 'Coordinator', description: 'Team coordinator' },
      routing: { rules: [] },
    });
    const report = detectDrift(doc, config);
    const routingEntries = report.entries.filter((e) => e.field === 'routing.rules');
    expect(routingEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect tool differences', () => {
    const doc = parseAgentDoc(FULL_DOC);
    const config = makeConfig({
      team: { name: 'Coordinator', description: 'Team coordinator' },
      models: {
        default: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        tiers: { premium: [], standard: [], fast: [] },
      },
      routing: {
        rules: [
          { pattern: 'feature-dev', agents: [] },
          { pattern: 'bug-fix', agents: [] },
          { pattern: 'documentation', agents: [] },
        ],
      },
      agents: [{ name: 'c', role: 'r', tools: ['grep', 'view'] }],
    });
    const report = detectDrift(doc, config);
    expect(report.inSync).toBe(false);
    // 'edit' and 'create' in doc but not config; 'view' in config but not doc
    const toolEntries = report.entries.filter((e) => e.field === 'agents[0].tools');
    expect(toolEntries.length).toBeGreaterThanOrEqual(2);
  });

  it('should report no drift for empty doc', () => {
    const doc = parseAgentDoc('');
    const config = makeConfig();
    const report = detectDrift(doc, config);
    expect(report.inSync).toBe(true);
  });
});
