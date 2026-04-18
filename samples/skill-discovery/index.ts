/**
 * Skill Discovery Sample
 *
 * Demonstrates the Squad SDK skills system:
 * - Loading skills from a directory of SKILL.md files
 * - Registering skills in a SkillRegistry
 * - Matching skills to task descriptions via triggers + role affinity
 * - The confidence lifecycle (low → medium → high)
 * - Discovering new patterns at runtime via parseSkillFile()
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SkillRegistry,
  loadSkillsFromDirectory,
  parseSkillFile,
  parseFrontmatter,
} from '@squad/sdk/skills';

// ── Helpers ──────────────────────────────────────────────

function heading(text: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(60)}\n`);
}

function subheading(text: string): void {
  console.log(`\n  ── ${text} ──\n`);
}

function confidenceIcon(level: string): string {
  if (level === 'high') return '🟢';
  if (level === 'medium') return '🟡';
  return '🔴';
}

// ── Pre-built skill files ────────────────────────────────

const SKILL_FILES: Record<string, string> = {
  'typescript-patterns': `---
name: TypeScript Patterns
domain: development
triggers: [typescript, types, generics, inference, strict]
roles: [developer, lead]
confidence: low
---
## TypeScript Patterns

Prefer \`unknown\` over \`any\` for type-safe narrowing.
Use discriminated unions for state machines.
Leverage the \`satisfies\` operator for type validation without widening.
Always enable strict mode in tsconfig.json.
`,

  'api-design': `---
name: API Design
domain: architecture
triggers: [api, rest, endpoint, schema, route]
roles: [backend, lead]
confidence: medium
---
## API Design Patterns

Use consistent resource naming (plural nouns: /users, /teams).
Version APIs via URL path prefix (/v1/, /v2/).
Return proper HTTP status codes (201 for creation, 404 for not found).
Design for pagination from day one (cursor-based preferred).
`,

  'testing-best-practices': `---
name: Testing Best Practices
domain: quality
triggers: [test, vitest, coverage, spec, assertion, mock]
roles: [tester, developer]
confidence: high
---
## Testing Best Practices

Write tests before fixing bugs (regression prevention).
Use \`describe\` blocks to group related tests by behavior.
Prefer real objects over mocks when feasible.
Target 80% coverage minimum, 100% on critical paths.
`,
};

// ── Main Demo ────────────────────────────────────────────

async function main(): Promise<void> {
  heading('🔍 Squad SDK — Skill Discovery Demo');

  // Create a temporary skills directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-skills-demo-'));
  const skillsDir = path.join(tmpDir, '.squad', 'skills');

  console.log('  Creating temporary skill files...');
  for (const [id, content] of Object.entries(SKILL_FILES)) {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  }
  console.log(`  📁 Skills directory: ${skillsDir}`);
  console.log(`  📄 Created ${Object.keys(SKILL_FILES).length} skill files`);

  try {
    // ─── Step 1: Load skills from directory ───
    subheading('Step 1: Load Skills from Directory');

    const skills = loadSkillsFromDirectory(skillsDir);
    console.log(`  Loaded ${skills.length} skills:\n`);

    for (const skill of skills) {
      const raw = fs.readFileSync(
        path.join(skillsDir, skill.id, 'SKILL.md'),
        'utf-8',
      );
      const { meta } = parseFrontmatter(raw);
      const confidence = (meta.confidence as string) || 'unknown';

      console.log(`  ${confidenceIcon(confidence)} ${skill.name}`);
      console.log(`     ID: ${skill.id}`);
      console.log(`     Domain: ${skill.domain}`);
      console.log(`     Triggers: [${skill.triggers.join(', ')}]`);
      console.log(`     Roles: [${skill.agentRoles.join(', ')}]`);
      console.log(`     Confidence: ${confidence}\n`);
    }

    // ─── Step 2: Register in a SkillRegistry ───
    subheading('Step 2: Register Skills in SkillRegistry');

    const registry = new SkillRegistry();
    for (const skill of skills) {
      registry.registerSkill(skill);
    }
    console.log(`  ✅ Registered ${registry.size} skills in the registry`);

    // ─── Step 3: Match skills to tasks ───
    subheading('Step 3: Match Skills to Tasks');

    const tasks = [
      { description: 'Add TypeScript generics to the data layer', role: 'developer' },
      { description: 'Design a REST API endpoint for user profiles', role: 'backend' },
      { description: 'Write vitest coverage tests for the auth module', role: 'tester' },
      { description: 'Review the API schema and add strict TypeScript types', role: 'lead' },
    ];

    for (const { description, role } of tasks) {
      console.log(`  📋 Task: "${description}"`);
      console.log(`     Role: ${role}`);

      const matches = registry.matchSkills(description, role);
      if (matches.length === 0) {
        console.log('     No matching skills found.\n');
      } else {
        for (const match of matches) {
          const pct = (match.score * 100).toFixed(0);
          console.log(`     → ${match.skill.name} (score: ${pct}%) — ${match.reason}`);
        }
        console.log();
      }
    }

    // ─── Step 4: Agent discovers a new pattern ───
    subheading('Step 4: Agent Discovers a New Pattern');

    console.log('  🤖 Agent is working on error handling...');
    console.log('  💡 Pattern detected: "Always use Result<T, E> for error handling"\n');

    const newSkillRaw = `---
name: Error Handling Patterns
domain: reliability
triggers: [error, exception, result, try, catch, handling]
roles: [developer, backend, tester]
confidence: low
---
## Error Handling Patterns

Use Result<T, E> type pattern instead of throwing exceptions.
Wrap external API calls in try/catch with typed error responses.
Log errors with structured context (operation, input, timestamp).
Never swallow errors silently — at minimum, log and re-throw.
`;

    const newSkill = parseSkillFile('error-handling', newSkillRaw);
    if (newSkill) {
      registry.registerSkill(newSkill);
      console.log(`  ✅ New skill registered: "${newSkill.name}"`);
      console.log(`     Domain: ${newSkill.domain}`);
      console.log(`     Triggers: [${newSkill.triggers.join(', ')}]`);
      console.log(`     Confidence: low (first observation)`);
      console.log(`\n  Registry now contains ${registry.size} skills`);
    }

    // ─── Step 5: Match with newly discovered skill ───
    subheading('Step 5: Match with Newly Discovered Skill');

    const errorTask = 'Handle API errors and add try-catch to the endpoint';
    console.log(`  📋 Task: "${errorTask}"`);
    console.log(`     Role: backend\n`);

    const errorMatches = registry.matchSkills(errorTask, 'backend');
    for (const match of errorMatches) {
      const pct = (match.score * 100).toFixed(0);
      console.log(`     → ${match.skill.name} (score: ${pct}%) — ${match.reason}`);
    }
    console.log();

    console.log('  💡 Why these matched:');
    console.log('     • Error Handling matched on triggers "error", "try", "catch"');
    console.log('       plus role affinity for "backend" → high score');
    console.log('     • API Design matched on trigger "api" + role affinity for "backend"');
    console.log('     • Skills with no matching triggers or roles are excluded');

    // ─── Step 6: Confidence lifecycle ───
    subheading('Step 6: Confidence Lifecycle');

    console.log('  The confidence lifecycle tracks how established a skill is:\n');
    console.log('  🔴 LOW    — First observation. Pattern just noticed by an agent.');
    console.log('             Agent spots a recurring error handling approach.');
    console.log();
    console.log('  🟡 MEDIUM — Confirmed. The pattern is validated across sessions.');
    console.log('             Multiple agents independently adopt the same approach.');
    console.log();
    console.log('  🟢 HIGH   — Established. Proven team standard.');
    console.log('             Testing best practices used across 50+ sessions.\n');

    console.log('  Current skill confidence levels:\n');
    for (const skill of registry.getAllSkills()) {
      const raw = SKILL_FILES[skill.id] || newSkillRaw;
      const { meta } = parseFrontmatter(raw);
      const confidence = (meta.confidence as string) || 'low';
      console.log(`  ${confidenceIcon(confidence)} ${skill.name} — ${confidence}`);
    }

    console.log('\n  As agents validate patterns, confidence progresses:');
    console.log('  error-handling: 🔴 low → 🟡 medium → 🟢 high');

    // ─── Done ───
    heading('✅ Demo Complete');
    console.log('  The skills system lets agents:');
    console.log('  • Load domain knowledge from SKILL.md files');
    console.log('  • Match relevant skills to tasks by triggers + role affinity');
    console.log('  • Discover and register new patterns during work');
    console.log('  • Track confidence as patterns are validated over time\n');
  } finally {
    // Always clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`  🧹 Cleaned up temporary directory: ${tmpDir}\n`);
  }
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
