/**
 * Skill Discovery — Acceptance Tests
 *
 * Validates the core SDK skills APIs used in the demo:
 * loadSkillsFromDirectory, parseSkillFile, parseFrontmatter, SkillRegistry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SkillRegistry,
  loadSkillsFromDirectory,
  parseSkillFile,
  parseFrontmatter,
} from '@squad/sdk/skills';
import type { SkillDefinition, SkillMatch } from '@squad/sdk/skills';

// ── Fixtures ─────────────────────────────────────────────

const VALID_SKILL = `---
name: TypeScript Patterns
domain: development
triggers: [typescript, types, generics]
roles: [developer, lead]
confidence: low
---
## TypeScript Patterns

Prefer unknown over any for type-safe narrowing.
`;

const API_SKILL = `---
name: API Design
domain: architecture
triggers: [api, rest, endpoint, schema]
roles: [backend, lead]
confidence: medium
---
## API Design

Use consistent resource naming.
`;

const TESTING_SKILL = `---
name: Testing Best Practices
domain: quality
triggers: [test, vitest, coverage, spec, mock]
roles: [tester, developer]
confidence: high
---
## Testing Best Practices

Write tests before fixing bugs.
`;

// ── Helpers ──────────────────────────────────────────────

let tmpDir: string;

function createSkillDir(skillsDir: string, id: string, content: string): void {
  const dir = path.join(skillsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

// ── Tests ────────────────────────────────────────────────

describe('Skill Discovery', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- parseFrontmatter ---

  describe('parseFrontmatter', () => {
    it('parses YAML-like frontmatter with string and array fields', () => {
      const { meta, body } = parseFrontmatter(VALID_SKILL);
      expect(meta.name).toBe('TypeScript Patterns');
      expect(meta.domain).toBe('development');
      expect(meta.triggers).toEqual(['typescript', 'types', 'generics']);
      expect(meta.roles).toEqual(['developer', 'lead']);
      expect(meta.confidence).toBe('low');
      expect(body).toContain('Prefer unknown over any');
    });

    it('returns empty meta for content without frontmatter', () => {
      const { meta, body } = parseFrontmatter('Just some content');
      expect(Object.keys(meta)).toHaveLength(0);
      expect(body).toBe('Just some content');
    });

    it('handles empty string', () => {
      const { meta, body } = parseFrontmatter('');
      expect(Object.keys(meta)).toHaveLength(0);
      expect(body).toBe('');
    });
  });

  // --- parseSkillFile ---

  describe('parseSkillFile', () => {
    it('creates a SkillDefinition from valid SKILL.md content', () => {
      const skill = parseSkillFile('ts-patterns', VALID_SKILL);
      expect(skill).toBeDefined();
      expect(skill!.id).toBe('ts-patterns');
      expect(skill!.name).toBe('TypeScript Patterns');
      expect(skill!.domain).toBe('development');
      expect(skill!.triggers).toEqual(['typescript', 'types', 'generics']);
      expect(skill!.agentRoles).toEqual(['developer', 'lead']);
      expect(skill!.content).toContain('Prefer unknown over any');
    });

    it('returns undefined for content with no body', () => {
      const skill = parseSkillFile('empty', '---\nname: Empty\n---\n');
      expect(skill).toBeUndefined();
    });

    it('uses id as fallback when name is missing from frontmatter', () => {
      const raw = `---
domain: misc
triggers: [foo]
roles: [dev]
---
Some body content.
`;
      const skill = parseSkillFile('my-fallback-id', raw);
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('my-fallback-id');
    });

    it('defaults to empty arrays when triggers and roles are missing', () => {
      const raw = `---
name: Minimal
---
Minimal body.
`;
      const skill = parseSkillFile('minimal', raw);
      expect(skill).toBeDefined();
      expect(skill!.triggers).toEqual([]);
      expect(skill!.agentRoles).toEqual([]);
    });
  });

  // --- loadSkillsFromDirectory ---

  describe('loadSkillsFromDirectory', () => {
    it('loads all valid skills from a directory', () => {
      const skillsDir = path.join(tmpDir, 'skills');
      createSkillDir(skillsDir, 'typescript-patterns', VALID_SKILL);
      createSkillDir(skillsDir, 'api-design', API_SKILL);
      createSkillDir(skillsDir, 'testing', TESTING_SKILL);

      const skills = loadSkillsFromDirectory(skillsDir);
      expect(skills).toHaveLength(3);

      const ids = skills.map((s) => s.id).sort();
      expect(ids).toEqual(['api-design', 'testing', 'typescript-patterns']);
    });

    it('returns empty array for non-existent directory', () => {
      const skills = loadSkillsFromDirectory(path.join(tmpDir, 'nope'));
      expect(skills).toEqual([]);
    });

    it('returns empty array for empty directory', () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const skills = loadSkillsFromDirectory(emptyDir);
      expect(skills).toEqual([]);
    });

    it('skips directories without SKILL.md', () => {
      const skillsDir = path.join(tmpDir, 'skills');
      createSkillDir(skillsDir, 'valid-skill', VALID_SKILL);
      // Create a directory with no SKILL.md
      fs.mkdirSync(path.join(skillsDir, 'no-skill'), { recursive: true });

      const skills = loadSkillsFromDirectory(skillsDir);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('valid-skill');
    });

    it('skips malformed SKILL.md files (no body)', () => {
      const skillsDir = path.join(tmpDir, 'skills');
      createSkillDir(skillsDir, 'good', VALID_SKILL);
      createSkillDir(skillsDir, 'bad', '---\nname: Bad\n---\n');

      const skills = loadSkillsFromDirectory(skillsDir);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('good');
    });
  });

  // --- SkillRegistry ---

  describe('SkillRegistry', () => {
    let registry: SkillRegistry;

    beforeEach(() => {
      registry = new SkillRegistry();
    });

    it('registers and retrieves skills', () => {
      const skill = parseSkillFile('ts', VALID_SKILL)!;
      registry.registerSkill(skill);

      expect(registry.size).toBe(1);
      expect(registry.getSkill('ts')).toBe(skill);
    });

    it('returns all registered skills', () => {
      registry.registerSkill(parseSkillFile('ts', VALID_SKILL)!);
      registry.registerSkill(parseSkillFile('api', API_SKILL)!);
      registry.registerSkill(parseSkillFile('test', TESTING_SKILL)!);

      const all = registry.getAllSkills();
      expect(all).toHaveLength(3);
    });

    it('unregisters a skill', () => {
      registry.registerSkill(parseSkillFile('ts', VALID_SKILL)!);
      expect(registry.size).toBe(1);

      const removed = registry.unregisterSkill('ts');
      expect(removed).toBe(true);
      expect(registry.size).toBe(0);
      expect(registry.getSkill('ts')).toBeUndefined();
    });

    it('returns undefined for unknown skill ID', () => {
      expect(registry.getSkill('nonexistent')).toBeUndefined();
    });

    it('loads skill content by ID', () => {
      const skill = parseSkillFile('ts', VALID_SKILL)!;
      registry.registerSkill(skill);

      const content = registry.loadSkill('ts');
      expect(content).toContain('Prefer unknown over any');
    });
  });

  // --- matchSkills ---

  describe('matchSkills', () => {
    let registry: SkillRegistry;

    beforeEach(() => {
      registry = new SkillRegistry();
      registry.registerSkill(parseSkillFile('ts', VALID_SKILL)!);
      registry.registerSkill(parseSkillFile('api', API_SKILL)!);
      registry.registerSkill(parseSkillFile('test', TESTING_SKILL)!);
    });

    it('matches skills by trigger keywords', () => {
      const matches = registry.matchSkills('Add TypeScript generics', 'nobody');
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].skill.id).toBe('ts');
      expect(matches[0].score).toBeGreaterThan(0);
      expect(matches[0].reason).toContain('triggers');
    });

    it('boosts score with role affinity', () => {
      // "typescript" trigger → ts skill matches
      const withoutRole = registry.matchSkills('typescript code', 'nobody');
      const withRole = registry.matchSkills('typescript code', 'developer');

      const tsWithout = withoutRole.find((m) => m.skill.id === 'ts');
      const tsWith = withRole.find((m) => m.skill.id === 'ts');

      expect(tsWithout).toBeDefined();
      expect(tsWith).toBeDefined();
      expect(tsWith!.score).toBeGreaterThan(tsWithout!.score);
      expect(tsWith!.reason).toContain('role affinity');
    });

    it('returns empty array when no skills match', () => {
      const matches = registry.matchSkills('unrelated topic about cooking', 'chef');
      expect(matches).toEqual([]);
    });

    it('sorts matches by score descending', () => {
      // "api endpoint" matches api-design on two triggers → higher score
      const matches = registry.matchSkills('api endpoint', 'backend');
      expect(matches.length).toBeGreaterThanOrEqual(1);

      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
      }
    });

    it('matches multiple skills for a cross-domain task', () => {
      const matches = registry.matchSkills(
        'Review the API schema and add strict TypeScript types',
        'lead',
      );
      expect(matches.length).toBeGreaterThanOrEqual(2);

      const ids = matches.map((m) => m.skill.id);
      expect(ids).toContain('ts');
      expect(ids).toContain('api');
    });

    it('caps score at 1.0', () => {
      const matches = registry.matchSkills(
        'test vitest coverage spec mock assertion',
        'tester',
      );
      const testMatch = matches.find((m) => m.skill.id === 'test');
      expect(testMatch).toBeDefined();
      expect(testMatch!.score).toBeLessThanOrEqual(1);
    });
  });

  // --- Confidence lifecycle (frontmatter convention) ---

  describe('confidence lifecycle', () => {
    it('reads confidence level from frontmatter metadata', () => {
      const { meta: lowMeta } = parseFrontmatter(VALID_SKILL);
      expect(lowMeta.confidence).toBe('low');

      const { meta: medMeta } = parseFrontmatter(API_SKILL);
      expect(medMeta.confidence).toBe('medium');

      const { meta: highMeta } = parseFrontmatter(TESTING_SKILL);
      expect(highMeta.confidence).toBe('high');
    });

    it('simulates confidence progression for a discovered skill', () => {
      const makeSkill = (confidence: string) => `---
name: Error Handling
domain: reliability
triggers: [error, exception]
roles: [developer]
confidence: ${confidence}
---
Use Result<T, E> for error handling.
`;
      // low → first observation
      const low = parseFrontmatter(makeSkill('low'));
      expect(low.meta.confidence).toBe('low');

      // medium → confirmed across sessions
      const med = parseFrontmatter(makeSkill('medium'));
      expect(med.meta.confidence).toBe('medium');

      // high → established team standard
      const high = parseFrontmatter(makeSkill('high'));
      expect(high.meta.confidence).toBe('high');
    });
  });

  // --- End-to-end: full demo flow ---

  describe('end-to-end demo flow', () => {
    it('loads skills, registers, matches, and discovers new skills', () => {
      // Create temp skill files
      const skillsDir = path.join(tmpDir, 'e2e-skills');
      createSkillDir(skillsDir, 'typescript-patterns', VALID_SKILL);
      createSkillDir(skillsDir, 'api-design', API_SKILL);
      createSkillDir(skillsDir, 'testing', TESTING_SKILL);

      // Load and register
      const skills = loadSkillsFromDirectory(skillsDir);
      expect(skills).toHaveLength(3);

      const registry = new SkillRegistry();
      for (const s of skills) registry.registerSkill(s);
      expect(registry.size).toBe(3);

      // Match a task
      const matches = registry.matchSkills('Write vitest tests', 'tester');
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].skill.name).toBe('Testing Best Practices');

      // Discover a new skill
      const newSkill = parseSkillFile('error-handling', `---
name: Error Handling
domain: reliability
triggers: [error, exception, result]
roles: [developer, backend]
confidence: low
---
Use Result<T, E> for error handling.
`);
      expect(newSkill).toBeDefined();
      registry.registerSkill(newSkill!);
      expect(registry.size).toBe(4);

      // New skill matches error-related tasks
      const errorMatches = registry.matchSkills('Handle API errors', 'backend');
      const errorMatch = errorMatches.find((m) => m.skill.id === 'error-handling');
      expect(errorMatch).toBeDefined();
      expect(errorMatch!.score).toBeGreaterThan(0);
    });
  });
});
