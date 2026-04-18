/**
 * Tests for Feature Audit (M3-13, Issue #154)
 */

import { describe, it, expect } from 'vitest';
import {
  auditFeatures,
  getHighRiskFeatures,
  generateAuditMarkdown,
  type FeatureAuditReport,
  type FeatureStatus,
} from '@squad/sdk/config';
import { DEFAULT_CONFIG, defineConfig, type SquadConfig } from '@squad/sdk/config';

// --- helpers ---

/** Fully-configured config with agents, routing, hooks, etc. */
function fullConfig(): SquadConfig {
  return defineConfig({
    version: '0.6.0',
    team: { name: 'Audit Squad' },
    agents: [
      { name: 'keaton', role: 'lead', status: 'active' },
      { name: 'mcmanus', role: 'developer', status: 'active' },
    ],
    routing: {
      rules: [{ pattern: '.*', agents: ['keaton'], tier: 'standard' }],
      fallbackBehavior: 'coordinator',
    },
    models: {
      default: 'claude-sonnet-4',
      defaultTier: 'standard',
      tiers: { standard: ['claude-sonnet-4'], fast: ['claude-haiku-4.5'], premium: ['claude-opus-4'] },
    },
    hooks: {
      blockedCommands: ['rm -rf'],
      scrubPii: true,
    },
  });
}

/** Minimal config — just defaults, no agents or routing rules */
function minimalConfig(): SquadConfig {
  return defineConfig({});
}

describe('auditFeatures', () => {
  it('should return a report with all 8 modules', () => {
    const report = auditFeatures(fullConfig());
    expect(report.features).toHaveLength(8);
    const names = report.features.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'coordinator', 'casting', 'skills', 'routing', 'models', 'hooks', 'tools', 'streaming',
      ]),
    );
  });

  it('should include timestamp and config version', () => {
    const report = auditFeatures(fullConfig());
    expect(report.timestamp).toBeTruthy();
    expect(report.configVersion).toBe('0.6.0');
  });

  it('should compute correct summary totals', () => {
    const report = auditFeatures(fullConfig());
    const s = report.summary;
    expect(s.total).toBe(8);
    expect(s.complete + s.partial + s.stub + s.missing).toBe(s.total);
  });

  it('should mark coordinator complete when agents and rules exist', () => {
    const report = auditFeatures(fullConfig());
    const coord = report.features.find((f) => f.name === 'coordinator')!;
    expect(coord.status).toBe('complete');
    expect(coord.riskLevel).toBe('low');
  });

  it('should mark coordinator stub when no agents or rules', () => {
    const report = auditFeatures(minimalConfig());
    const coord = report.features.find((f) => f.name === 'coordinator')!;
    expect(coord.status).toBe('stub');
    expect(coord.riskLevel).toBe('high');
  });

  it('should mark routing partial when only fallback but no rules', () => {
    const cfg = defineConfig({ routing: { rules: [], fallbackBehavior: 'coordinator' } });
    const report = auditFeatures(cfg);
    const routing = report.features.find((f) => f.name === 'routing')!;
    expect(routing.status).toBe('partial');
  });

  it('should mark routing complete with rules and fallback', () => {
    const report = auditFeatures(fullConfig());
    const routing = report.features.find((f) => f.name === 'routing')!;
    expect(routing.status).toBe('complete');
  });

  it('should mark models complete with default and tiers', () => {
    const report = auditFeatures(fullConfig());
    const models = report.features.find((f) => f.name === 'models')!;
    expect(models.status).toBe('complete');
  });

  it('should mark hooks complete when policies are configured', () => {
    const report = auditFeatures(fullConfig());
    const hooks = report.features.find((f) => f.name === 'hooks')!;
    expect(hooks.status).toBe('complete');
    expect(hooks.riskLevel).toBe('low');
  });

  it('should mark hooks partial when no hooks section', () => {
    const cfg = defineConfig({});
    const report = auditFeatures(cfg);
    const hooks = report.features.find((f) => f.name === 'hooks')!;
    expect(hooks.status).toBe('partial');
    expect(hooks.riskLevel).toBe('medium');
  });

  it('should always mark tools as complete', () => {
    const report = auditFeatures(minimalConfig());
    const tools = report.features.find((f) => f.name === 'tools')!;
    expect(tools.status).toBe('complete');
  });

  it('should always mark streaming as complete', () => {
    const report = auditFeatures(minimalConfig());
    const streaming = report.features.find((f) => f.name === 'streaming')!;
    expect(streaming.status).toBe('complete');
  });

  it('should always mark skills as complete', () => {
    const report = auditFeatures(minimalConfig());
    const skills = report.features.find((f) => f.name === 'skills')!;
    expect(skills.status).toBe('complete');
  });
});

describe('getHighRiskFeatures', () => {
  it('should return only high-risk features', () => {
    const report = auditFeatures(minimalConfig());
    const high = getHighRiskFeatures(report);
    high.forEach((f) => expect(f.riskLevel).toBe('high'));
  });

  it('should return empty array when everything is configured', () => {
    const report = auditFeatures(fullConfig());
    const high = getHighRiskFeatures(report);
    expect(high).toHaveLength(0);
  });

  it('should include coordinator for minimal config', () => {
    const report = auditFeatures(minimalConfig());
    const high = getHighRiskFeatures(report);
    const names = high.map((f) => f.name);
    expect(names).toContain('coordinator');
  });
});

describe('generateAuditMarkdown', () => {
  it('should produce a non-empty markdown string', () => {
    const report = auditFeatures(fullConfig());
    const md = generateAuditMarkdown(report);
    expect(md.length).toBeGreaterThan(0);
  });

  it('should include the report heading', () => {
    const md = generateAuditMarkdown(auditFeatures(fullConfig()));
    expect(md).toContain('# Feature Audit Report');
  });

  it('should include summary table', () => {
    const md = generateAuditMarkdown(auditFeatures(fullConfig()));
    expect(md).toContain('Total modules');
    expect(md).toContain('Complete');
  });

  it('should include module detail rows', () => {
    const md = generateAuditMarkdown(auditFeatures(fullConfig()));
    expect(md).toContain('| coordinator |');
    expect(md).toContain('| casting |');
    expect(md).toContain('| streaming |');
  });

  it('should include high risk section when risks exist', () => {
    const md = generateAuditMarkdown(auditFeatures(minimalConfig()));
    expect(md).toContain('High Risk Items');
  });

  it('should not include high risk section when no risks', () => {
    const md = generateAuditMarkdown(auditFeatures(fullConfig()));
    expect(md).not.toContain('High Risk Items');
  });

  it('should include config version', () => {
    const md = generateAuditMarkdown(auditFeatures(fullConfig()));
    expect(md).toContain('0.6.0');
  });
});
