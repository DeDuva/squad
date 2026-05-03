/**
 * CRLF normalization tests — Issue #228 (Epic #181)
 *
 * Validates that all markdown parsers strip \r\n → \n so parsed values
 * never contain trailing \r characters, even when source files use
 * Windows-style CRLF line endings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseTeamMarkdown,
  parseDecisionsMarkdown,
} from '@deduvafork/squad-sdk/config';
import { parseRoutingMarkdown } from '@deduvafork/squad-sdk/config';
import { parseCharterMarkdown } from '@deduvafork/squad-sdk/agents';
import { loadSkillsFromDirectory } from '@deduvafork/squad-sdk/skills';

// ---------------------------------------------------------------------------
// Helper: convert all \n to \r\n so we can replay happy-path inputs as CRLF
// ---------------------------------------------------------------------------

function withCRLF(input: string): string {
  return input.replace(/\r?\n/g, '\r\n');
}

/** Assert no \r anywhere in a value (string, array of strings, or object). */
function expectNoCR(value: unknown, label = 'value'): void {
  if (typeof value === 'string') {
    expect(value, `${label} should not contain \\r`).not.toContain('\r');
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => expectNoCR(v, `${label}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expectNoCR(v, `${label}.${k}`);
    }
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('CRLF normalization', () => {
  // -------------------------------------------------------------------------
  // parseTeamMarkdown
  // -------------------------------------------------------------------------

  describe('parseTeamMarkdown', () => {
    it('CRLF table format — no trailing \\r on agent names', () => {
      const md = withCRLF(`
## Roster

| Name | Role | Skills | Model |
|------|------|--------|-------|
| Keaton | Lead | architecture, design | claude-opus-4.5 |
| Harper | Developer | typescript, testing | |
`);
      const { agents, warnings } = parseTeamMarkdown(md);
      expect(agents).toHaveLength(2);
      expectNoCR(agents[0].name, 'agents[0].name');
      expectNoCR(agents[1].name, 'agents[1].name');
      expect(agents[0].name).toBe('keaton');
      expect(agents[0].role).toBe('Lead');
      expect(agents[0].model).toBe('claude-opus-4.5');
      expectNoCR(warnings, 'warnings');
    });

    it('CRLF section format — clean role parsing', () => {
      const md = withCRLF(`
## Team Members

### Keaton
- **Role:** Lead
- **Skills:** architecture, design
- **Model:** claude-opus-4.5

### Harper
- **Role:** Developer
- **Skills:** typescript
`);
      const { agents } = parseTeamMarkdown(md);
      expect(agents).toHaveLength(2);
      expectNoCR(agents[0], 'agents[0]');
      expectNoCR(agents[1], 'agents[1]');
      expect(agents[0].role).toBe('Lead');
      expect(agents[1].role).toBe('Developer');
    });

    it('mixed \\n and \\r\\n line endings', () => {
      // Intentionally mix: first line LF, rest CRLF
      const md =
        '## Roster\n' +
        '| Name | Role | Skills | Model |\r\n' +
        '|------|------|--------|-------|\r\n' +
        '| Keaton | Lead | architecture | claude-opus-4.5 |\n' +
        '| Harper | Developer | typescript | |\r\n';

      const { agents } = parseTeamMarkdown(md);
      expect(agents).toHaveLength(2);
      expectNoCR(agents[0], 'agents[0]');
      expectNoCR(agents[1], 'agents[1]');
    });

    it('CRLF in skill list values', () => {
      const md = withCRLF(`
## Roster

| Name | Role | Skills | Model |
|------|------|--------|-------|
| Fenster | Core Dev | typescript, node, architecture, testing | claude-sonnet-4.5 |
`);
      const { agents } = parseTeamMarkdown(md);
      expect(agents).toHaveLength(1);
      expectNoCR(agents[0].skills, 'skills');
      expect(agents[0].skills).toContain('typescript');
      expect(agents[0].skills).toContain('testing');
    });
  });

  // -------------------------------------------------------------------------
  // parseDecisionsMarkdown
  // -------------------------------------------------------------------------

  describe('parseDecisionsMarkdown', () => {
    it('CRLF headings — clean titles', () => {
      const md = withCRLF(`
## Use Claude Opus for architecture
This decision sets the model tier for architecture reviews.

## Code style
Use prettier and eslint.
`);
      const { decisions } = parseDecisionsMarkdown(md);
      expect(decisions).toHaveLength(2);
      expectNoCR(decisions[0].title, 'title[0]');
      expectNoCR(decisions[1].title, 'title[1]');
      expect(decisions[0].title).toBe('Use Claude Opus for architecture');
      expect(decisions[1].title).toBe('Code style');
    });

    it('CRLF body content', () => {
      const md = withCRLF(`
## Infrastructure
Routing rules should prefer the lead agent for complex tasks.
This paragraph has multiple lines
that continue across CRLF boundaries.
`);
      const { decisions } = parseDecisionsMarkdown(md);
      expect(decisions).toHaveLength(1);
      expectNoCR(decisions[0].body, 'body');
      expectNoCR(decisions[0].title, 'title');
    });

    it('CRLF config relevance detection', () => {
      const md = withCRLF(`
## Use Claude Opus for architecture
This decision sets the model tier for architecture reviews.

## Code style
Use prettier and eslint.
`);
      const { decisions } = parseDecisionsMarkdown(md);
      expect(decisions[0].configRelevant).toBe(true);
      expect(decisions[1].configRelevant).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // parseRoutingMarkdown
  // -------------------------------------------------------------------------

  describe('parseRoutingMarkdown', () => {
    it('CRLF routing table — clean workType and agents', () => {
      const md = withCRLF(`
# Work Routing

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| feature-dev | Lead | New features, enhancements |
| bug-fix | Developer | Bug fixes, patches |
| testing | Tester | Write tests, QA |
`);
      const config = parseRoutingMarkdown(md);
      expect(config.rules).toHaveLength(3);
      config.rules.forEach((rule, i) => {
        expectNoCR(rule.workType, `rules[${i}].workType`);
        expectNoCR(rule.agents, `rules[${i}].agents`);
        if (rule.examples) expectNoCR(rule.examples, `rules[${i}].examples`);
      });
      expect(config.rules[0].workType).toBe('feature-dev');
      expect(config.rules[0].agents).toEqual(['Lead']);
    });

    it('CRLF multi-agent routing rows', () => {
      const md = withCRLF(`
## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| security | Lead, Security | Security review, audits |
| testing | Tester, Developer | Unit tests, integration tests |
`);
      const config = parseRoutingMarkdown(md);
      expect(config.rules).toHaveLength(2);
      expect(config.rules[0].agents).toEqual(['Lead', 'Security']);
      expect(config.rules[1].agents).toEqual(['Tester', 'Developer']);
      config.rules.forEach((rule, i) => {
        expectNoCR(rule.agents, `rules[${i}].agents`);
      });
    });
  });

  // -------------------------------------------------------------------------
  // parseCharterMarkdown
  // -------------------------------------------------------------------------

  describe('parseCharterMarkdown', () => {
    const SAMPLE_CHARTER = `# Fenster

## Identity

**Name:** Fenster
**Role:** Core Developer
**Expertise:** TypeScript, testing, architecture
**Style:** Precise and methodical

## What I Own

- src/config/
- src/agents/

## Boundaries

Do not modify docs/ or marketing.

## Model

**Preferred:** claude-sonnet-4.5

## Collaboration

Coordinate with Verbal on prompt changes.
`;

    it('CRLF identity section', () => {
      const parsed = parseCharterMarkdown(withCRLF(SAMPLE_CHARTER));
      expectNoCR(parsed.identity, 'identity');
      expect(parsed.identity.name).toBe('Fenster');
      expect(parsed.identity.role).toBe('Core Developer');
      expect(parsed.identity.expertise).toContain('TypeScript');
      expect(parsed.identity.style).toBe('Precise and methodical');
    });

    it('CRLF boundaries/ownership sections', () => {
      const parsed = parseCharterMarkdown(withCRLF(SAMPLE_CHARTER));
      expectNoCR(parsed.ownership, 'ownership');
      expectNoCR(parsed.boundaries, 'boundaries');
      expect(parsed.ownership).toContain('src/config/');
      expect(parsed.boundaries).toContain('Do not modify docs/');
    });

    it('CRLF model preference', () => {
      const parsed = parseCharterMarkdown(withCRLF(SAMPLE_CHARTER));
      expectNoCR(parsed.modelPreference, 'modelPreference');
      expect(parsed.modelPreference).toBe('claude-sonnet-4.5');
    });
  });

  // -------------------------------------------------------------------------
  // loadSkillsFromDirectory
  // -------------------------------------------------------------------------

  describe('loadSkillsFromDirectory', () => {
    const testDir = path.join('test-fixtures', `crlf-skills-${randomUUID().slice(0, 8)}`);

    beforeEach(() => {
      fs.mkdirSync(path.join(testDir, 'my-skill'), { recursive: true });
      // Write SKILL.md with explicit CRLF line endings
      const content = [
        '---',
        'name: My Skill',
        'domain: testing',
        'triggers: [vitest, jest]',
        'roles: [tester]',
        '---',
        '# My Skill',
        'Content here.',
      ].join('\r\n');
      fs.writeFileSync(path.join(testDir, 'my-skill', 'SKILL.md'), content, 'utf-8');
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('CRLF SKILL.md frontmatter on disk', () => {
      const skills = loadSkillsFromDirectory(testDir);
      expect(skills).toHaveLength(1);
      expectNoCR(skills[0].name, 'name');
      expectNoCR(skills[0].domain, 'domain');
      expectNoCR(skills[0].triggers, 'triggers');
      expectNoCR(skills[0].content, 'content');
      expect(skills[0].name).toBe('My Skill');
      expect(skills[0].domain).toBe('testing');
      expect(skills[0].triggers).toEqual(['vitest', 'jest']);
    });
  });
});
