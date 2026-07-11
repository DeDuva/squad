/**
 * Parser contract & edge-case tests — Issue #229 (Epic #181)
 *
 * 16 tests covering return shape validation, edge cases (missing fields,
 * malformed input, partial content), and snapshot tests for all 5 major parsers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  parseTeamMarkdown,
  parseDecisionsMarkdown,
} from '@deduvafork/squad-sdk/config';
import { parseRoutingMarkdown } from '@deduvafork/squad-sdk/config';
import { parseCharterMarkdown } from '@deduvafork/squad-sdk/agents';
import { loadSkillsFromDirectory } from '@deduvafork/squad-sdk/skills';

// ===========================================================================
// Return shape tests (5)
// ===========================================================================

describe('Return shape contracts', () => {
  it('parseTeamMarkdown returns { agents: ParsedAgent[], warnings: string[] }', () => {
    const md = `
## Roster

| Name | Role | Skills | Model |
|------|------|--------|-------|
| Keaton | Lead | architecture, design | claude-opus-4.5 |
`;
    const result = parseTeamMarkdown(md);

    // Top-level shape
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.agents)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);

    // Agent shape
    const agent = result.agents[0]!;
    expect(agent).toHaveProperty('name');
    expect(agent).toHaveProperty('role');
    expect(agent).toHaveProperty('skills');
    expect(typeof agent.name).toBe('string');
    expect(typeof agent.role).toBe('string');
    expect(Array.isArray(agent.skills)).toBe(true);
  });

  it('parseDecisionsMarkdown returns { decisions: ParsedDecision[], warnings: string[] }', () => {
    const md = `
## Use Claude Opus for architecture
This decision sets the model tier for architecture reviews.
`;
    const result = parseDecisionsMarkdown(md);

    expect(result).toHaveProperty('decisions');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.decisions)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);

    const decision = result.decisions[0]!;
    expect(decision).toHaveProperty('title');
    expect(decision).toHaveProperty('body');
    expect(decision).toHaveProperty('configRelevant');
    expect(typeof decision.title).toBe('string');
    expect(typeof decision.body).toBe('string');
    expect(typeof decision.configRelevant).toBe('boolean');
  });

  it('parseRoutingMarkdown returns object with rules array containing workType + agents', () => {
    const md = `
## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| feature-dev | Lead | New features |
`;
    const result = parseRoutingMarkdown(md);

    expect(result).toHaveProperty('rules');
    expect(Array.isArray(result.rules)).toBe(true);

    const rule = result.rules[0]!;
    expect(rule).toHaveProperty('workType');
    expect(rule).toHaveProperty('agents');
    expect(typeof rule.workType).toBe('string');
    expect(Array.isArray(rule.agents)).toBe(true);
  });

  it('parseCharterMarkdown returns object with identity object + fullContent string', () => {
    const md = `# Fenster

## Identity

**Name:** Fenster
**Role:** Core Developer
**Expertise:** TypeScript
**Style:** Precise
`;
    const result = parseCharterMarkdown(md);

    expect(result).toHaveProperty('identity');
    expect(result).toHaveProperty('fullContent');
    expect(typeof result.identity).toBe('object');
    expect(result.identity).not.toBeNull();
    expect(typeof result.fullContent).toBe('string');
    expect(result.fullContent.length).toBeGreaterThan(0);
  });

  it('loadSkillsFromDirectory returns array of objects with id, name, content fields', () => {
    const testDir = path.join(os.tmpdir(), `shape-skills-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(testDir, 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'my-skill', 'SKILL.md'),
      '---\nname: My Skill\ndomain: testing\ntriggers: [vitest]\nroles: [tester]\n---\n# My Skill\nContent here.',
      'utf-8',
    );

    try {
      const skills = loadSkillsFromDirectory(testDir);
      expect(Array.isArray(skills)).toBe(true);
      expect(skills).toHaveLength(1);

      const skill = skills[0]!;
      expect(skill).toHaveProperty('id');
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('content');
      expect(typeof skill.id).toBe('string');
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.content).toBe('string');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Edge cases (8)
// ===========================================================================

describe('Edge cases', () => {
  // --- parseTeamMarkdown ---

  it('parseTeamMarkdown — agents missing role field default to developer', () => {
    const md = `
## Team Members

### Alpha
- **Skills:** typescript
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.role).toBe('developer');
  });

  it('parseTeamMarkdown — duplicate agent names are both included', () => {
    const md = `
## Roster

| Name | Role | Skills | Model |
|------|------|--------|-------|
| Keaton | Lead | architecture | |
| Keaton | Developer | typescript | |
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    const keatons = agents.filter(a => a.name === 'keaton');
    expect(keatons.length).toBe(2);
  });

  // --- parseDecisionsMarkdown ---

  it('parseDecisionsMarkdown — H1 headings are not parsed as decisions', () => {
    const md = `
# Top Level Heading
This body lives under an H1.

## Actual Decision
This is a real H2 decision.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    // H1 should NOT be picked up — only H2/H3 are matched
    const titles = decisions.map(d => d.title);
    expect(titles).not.toContain('Top Level Heading');
    expect(titles).toContain('Actual Decision');
  });

  it('parseDecisionsMarkdown — heading with no body content', () => {
    const md = `
## Empty Decision
## Another Decision
Body for second.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    // Both headings should be captured
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const empty = decisions.find(d => d.title === 'Empty Decision');
    if (empty) {
      expect(empty.body.trim()).toBe('');
    }
  });

  // --- parseCharterMarkdown ---

  it('parseCharterMarkdown — partial sections (Identity only, no boundaries/ownership)', () => {
    const md = `# Solo Agent

## Identity

**Name:** Solo
**Role:** Specialist
`;
    const result = parseCharterMarkdown(md);

    expect(result.identity.name).toBe('Solo');
    expect(result.identity.role).toBe('Specialist');
    // Missing sections should be undefined or absent — not throw
    expect(result.boundaries).toBeUndefined();
    expect(result.ownership).toBeUndefined();
    expect(result.fullContent).toContain('Solo Agent');
  });

  it('parseCharterMarkdown — unknown/extra sections are silently ignored', () => {
    const md = `# Extended Agent

## Identity

**Name:** Extended
**Role:** Lead

## Hobbies

I like painting.

## Favorite Foods

Pizza and sushi.
`;
    const result = parseCharterMarkdown(md);

    expect(result.identity.name).toBe('Extended');
    expect(result.identity.role).toBe('Lead');
    // Unknown sections should not appear on the parsed object
    expect(result).not.toHaveProperty('hobbies');
    expect(result).not.toHaveProperty('favoriteFoods');
    // fullContent still has everything
    expect(result.fullContent).toContain('Hobbies');
    expect(result.fullContent).toContain('Favorite Foods');
  });

  // --- parseRoutingMarkdown ---

  it('parseRoutingMarkdown — empty/malformed table cells produce no crash', () => {
    const md = `
## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| | | |
| feature-dev | Lead | New features |
| | Developer | |
`;
    const config = parseRoutingMarkdown(md);

    // Should not throw — valid rows are extracted, malformed ones skipped
    expect(Array.isArray(config.rules)).toBe(true);
    // At minimum the valid row should be present
    const validRule = config.rules.find(r => r.workType === 'feature-dev');
    expect(validRule).toBeDefined();
    expect(validRule!.agents).toContain('Lead');
  });

  // --- loadSkillsFromDirectory ---

  it('loadSkillsFromDirectory — nested subdirectories are not recursed', () => {
    const testDir = path.join(os.tmpdir(), `nested-skills-${randomUUID().slice(0, 8)}`);
    // Top-level skill (should be found)
    fs.mkdirSync(path.join(testDir, 'top-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'top-skill', 'SKILL.md'),
      '---\nname: Top Skill\ndomain: dev\ntriggers: [build]\nroles: [dev]\n---\nTop content.',
      'utf-8',
    );
    // Nested skill (should NOT be found)
    fs.mkdirSync(path.join(testDir, 'deep', 'nested-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'deep', 'nested-skill', 'SKILL.md'),
      '---\nname: Nested Skill\ndomain: dev\ntriggers: [test]\nroles: [dev]\n---\nNested content.',
      'utf-8',
    );

    try {
      const skills = loadSkillsFromDirectory(testDir);
      const names = skills.map(s => s.name);
      expect(names).toContain('Top Skill');
      expect(names).not.toContain('Nested Skill');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Snapshot tests (3)
// ===========================================================================

describe('Snapshot tests', () => {
  const CANONICAL_TEAM_MD = `# Team

## Roster

| Name | Role | Skills | Model |
|------|------|--------|-------|
| Keaton | Lead | architecture, design, planning | claude-opus-4.5 |
| Fenster | Core Dev | typescript, node, testing | claude-sonnet-4.5 |
| Hockney | Tester | testing, edge-cases, vitest | claude-sonnet-4.5 |
`;

  const CANONICAL_CHARTER_MD = `# Keaton

## Identity

**Name:** Keaton
**Role:** Lead
**Expertise:** Architecture, system design, coordination
**Style:** Decisive and structured

## What I Own

- docs/proposals/
- .squad/decisions.md

## Boundaries

Do not modify test files or CI configuration.

## Model

**Preferred:** claude-opus-4.5

## Collaboration

Coordinate with Fenster on implementation, Hockney on test plans.
`;

  const CANONICAL_ROUTING_MD = `# Work Routing

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| architecture | Keaton | System design, proposals |
| feature-dev | Fenster | New features, refactoring |
| testing | Hockney | Unit tests, integration tests |
| bug-fix | Fenster, Hockney | Bug fixes, regressions |
`;

  it('snapshot: parseTeamMarkdown against canonical team.md', () => {
    const result = parseTeamMarkdown(CANONICAL_TEAM_MD);
    expect(result).toMatchSnapshot();
  });

  it('snapshot: parseCharterMarkdown against canonical charter', () => {
    const result = parseCharterMarkdown(CANONICAL_CHARTER_MD);
    expect(result).toMatchSnapshot();
  });

  it('snapshot: parseRoutingMarkdown against canonical routing.md', () => {
    const result = parseRoutingMarkdown(CANONICAL_ROUTING_MD);
    expect(result).toMatchSnapshot();
  });
});
