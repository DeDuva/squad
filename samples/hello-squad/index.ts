/**
 * hello-squad — Beginner sample for @squad/sdk
 *
 * Demonstrates:
 *  1. resolveSquad() — locate or create a .squad/ directory
 *  2. CastingEngine  — cast a themed team from a universe
 *  3. onboardAgent() — onboard each agent with a charter
 *  4. CastingHistory — persistent name registry
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveSquad,
  CastingEngine,
  CastingHistory,
  onboardAgent,
} from '@squad/sdk';
import type { CastMember, AgentRole } from '@squad/sdk';

// ── Helpers ──────────────────────────────────────────────────────────

function hr(label: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🎬 hello-squad — Squad SDK beginner sample\n');

  // ── Step 1: Resolve (or create) a .squad/ directory ──────────────
  hr('Step 1 — Resolve .squad/ directory');

  // Use a temp directory so the sample doesn't write into the repo
  const demoRoot = join(tmpdir(), 'hello-squad-demo');
  const squadDir = join(demoRoot, '.squad');

  if (!existsSync(squadDir)) {
    mkdirSync(squadDir, { recursive: true });
    console.log(`✅ Created demo .squad/ at: ${squadDir}`);
  } else {
    console.log(`✅ .squad/ already exists at: ${squadDir}`);
  }

  // Verify resolveSquad() finds it
  const resolved = resolveSquad(demoRoot);
  console.log(`   resolveSquad() → ${resolved ?? '(not found)'}`);

  // ── Step 2: Cast a team of 4 agents ──────────────────────────────
  hr('Step 2 — Cast a team from "The Usual Suspects"');

  const engine = new CastingEngine();
  const roles: AgentRole[] = ['lead', 'developer', 'tester', 'scribe'];

  const team: CastMember[] = engine.castTeam({
    universe: 'usual-suspects',
    teamSize: roles.length,
    requiredRoles: roles,
  });

  console.log(`\n  Universe: The Usual Suspects`);
  console.log(`  Team size: ${team.length}\n`);

  for (const member of team) {
    console.log(`  🎭 ${member.displayName}`);
    console.log(`     Personality: ${member.personality}`);
    console.log(`     Backstory:   ${member.backstory}\n`);
  }

  // ── Step 3: Onboard each agent ───────────────────────────────────
  hr('Step 3 — Onboard agents');

  for (const member of team) {
    const agentDir = join(squadDir, 'agents', member.name.toLowerCase());
    if (existsSync(agentDir)) {
      console.log(`  ⏭  ${member.name} already onboarded — skipping`);
      continue;
    }

    const result = await onboardAgent({
      teamRoot: demoRoot,
      agentName: member.name.toLowerCase(),
      role: member.role,
      displayName: member.displayName,
      projectContext: 'Hello Squad demo — a beginner sample showcasing the SDK casting & onboarding APIs.',
      userName: 'DemoUser',
    });

    console.log(`  ✅ ${member.displayName}`);
    console.log(`     Dir:     ${result.agentDir}`);
    console.log(`     Charter: ${result.charterPath}`);
    console.log(`     History: ${result.historyPath}`);
  }

  // ── Step 4: Display the team roster ──────────────────────────────
  hr('Step 4 — Team roster');

  console.log('\n  ┌─────────────┬──────────────────┬──────────────────────────────────────────┐');
  console.log('  │ Name        │ Role             │ Personality                              │');
  console.log('  ├─────────────┼──────────────────┼──────────────────────────────────────────┤');

  for (const m of team) {
    const name = m.name.padEnd(11);
    const role = m.role.padEnd(16);
    const personality = m.personality.slice(0, 40).padEnd(40);
    console.log(`  │ ${name} │ ${role} │ ${personality} │`);
  }

  console.log('  └─────────────┴──────────────────┴──────────────────────────────────────────┘');

  // ── Step 5: Casting registry — names are persistent ──────────────
  hr('Step 5 — Casting history (persistent names)');

  const history = new CastingHistory();

  // Record our first cast
  const config = { universe: 'usual-suspects' as const, teamSize: 4, requiredRoles: roles };
  history.recordCast(team, config);

  // Cast the same config again — names are deterministic
  const team2 = engine.castTeam(config);
  history.recordCast(team2, config);

  console.log(`\n  Casting records: ${history.size}`);
  console.log('  Cast #1 names:', team.map(m => m.name).join(', '));
  console.log('  Cast #2 names:', team2.map(m => m.name).join(', '));

  const match = team.every((m, i) => m.name === team2[i].name);
  console.log(`  Names match across casts: ${match ? '✅ Yes' : '❌ No'}`);

  // Serialize history (what you'd persist to disk)
  const serialized = history.serializeHistory();
  console.log(`  Serialized history version: ${serialized.version}`);
  console.log(`  Records in history: ${serialized.records.length}`);

  // Query history for a specific agent
  const keyserHistory = history.getAgentHistory('Keyser');
  console.log(`  Keyser appeared in ${keyserHistory.length} cast(s)`);

  hr('Done! 🎉');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
