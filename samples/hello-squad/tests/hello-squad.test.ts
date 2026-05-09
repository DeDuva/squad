/**
 * hello-squad acceptance tests
 *
 * Validates the core casting + onboarding workflow shown in the sample.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveSquad,
  CastingEngine,
  CastingHistory,
  onboardAgent,
} from '@deduvafork/squad-sdk';
import type { CastMember, AgentRole } from '@deduvafork/squad-sdk';

const TEST_ROOT = join(tmpdir(), 'hello-squad-test-' + Date.now());
const SQUAD_DIR = join(TEST_ROOT, '.squad');

beforeEach(() => {
  mkdirSync(SQUAD_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('resolveSquad', () => {
  it('finds the .squad directory from a subdirectory', () => {
    const sub = join(TEST_ROOT, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const result = resolveSquad(sub);
    expect(result).toBe(SQUAD_DIR);
  });

  it('returns null when no .squad directory exists', () => {
    const empty = join(tmpdir(), 'no-squad-' + Date.now());
    mkdirSync(empty, { recursive: true });
    // Place a .git marker so the walk stops
    mkdirSync(join(empty, '.git'));
    const result = resolveSquad(empty);
    expect(result).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('CastingEngine.castTeam', () => {
  const engine = new CastingEngine();
  const roles: AgentRole[] = ['lead', 'developer', 'tester', 'scribe'];

  it('casts the right number of agents', () => {
    const team = engine.castTeam({ universe: 'usual-suspects', teamSize: 4, requiredRoles: roles });
    expect(team).toHaveLength(4);
  });

  it('fills all required roles', () => {
    const team = engine.castTeam({ universe: 'usual-suspects', teamSize: 4, requiredRoles: roles });
    const teamRoles = team.map(m => m.role);
    for (const role of roles) {
      expect(teamRoles).toContain(role);
    }
  });

  it('assigns unique names', () => {
    const team = engine.castTeam({ universe: 'usual-suspects', teamSize: 4, requiredRoles: roles });
    const names = team.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names are deterministic across casts', () => {
    const config = { universe: 'usual-suspects' as const, teamSize: 4, requiredRoles: roles };
    const team1 = engine.castTeam(config);
    const team2 = engine.castTeam(config);
    expect(team1.map(m => m.name)).toEqual(team2.map(m => m.name));
  });

  it('each member has displayName, personality, backstory', () => {
    const team = engine.castTeam({ universe: 'usual-suspects', teamSize: 4, requiredRoles: roles });
    for (const member of team) {
      expect(member.displayName).toBeTruthy();
      expect(member.personality).toBeTruthy();
      expect(member.backstory).toBeTruthy();
    }
  });

  it('supports oceans-eleven universe', () => {
    const team = engine.castTeam({ universe: 'oceans-eleven', teamSize: 3, requiredRoles: ['lead', 'developer', 'tester'] });
    expect(team).toHaveLength(3);
  });
});

describe('onboardAgent', () => {
  it('creates charter and history files', async () => {
    const result = await onboardAgent({
      teamRoot: TEST_ROOT,
      agentName: 'testbot',
      role: 'developer',
      displayName: 'Testbot — Developer',
      projectContext: 'Test project context',
      userName: 'Tester',
    });

    expect(result.createdFiles).toHaveLength(2);
    expect(existsSync(result.charterPath)).toBe(true);
    expect(existsSync(result.historyPath)).toBe(true);

    const charter = await readFile(result.charterPath, 'utf-8');
    expect(charter).toContain('Testbot');
    expect(charter).toContain('Developer');

    const history = await readFile(result.historyPath, 'utf-8');
    expect(history).toContain('Tester');
    expect(history).toContain('Test project context');
  });

  it('throws if agent directory already exists', async () => {
    await onboardAgent({
      teamRoot: TEST_ROOT,
      agentName: 'duplicate',
      role: 'tester',
    });

    await expect(
      onboardAgent({ teamRoot: TEST_ROOT, agentName: 'duplicate', role: 'tester' }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('CastingHistory', () => {
  it('records and retrieves casting history', () => {
    const engine = new CastingEngine();
    const history = new CastingHistory();
    const config = { universe: 'usual-suspects' as const, teamSize: 3, requiredRoles: ['lead', 'developer', 'tester'] as AgentRole[] };
    const team = engine.castTeam(config);

    history.recordCast(team, config);
    expect(history.size).toBe(1);

    const records = history.getCastHistory();
    expect(records).toHaveLength(1);
    expect(records[0].universe).toBe('usual-suspects');
    expect(records[0].members).toHaveLength(3);
  });

  it('serializes and deserializes correctly', () => {
    const engine = new CastingEngine();
    const history = new CastingHistory();
    const config = { universe: 'usual-suspects' as const, teamSize: 2, requiredRoles: ['lead', 'developer'] as AgentRole[] };
    const team = engine.castTeam(config);

    history.recordCast(team, config);
    const serialized = history.serializeHistory();

    const restored = new CastingHistory();
    restored.deserializeHistory(serialized);
    expect(restored.size).toBe(1);
    expect(restored.getCastHistory()[0].members.map(m => m.name))
      .toEqual(team.map(m => m.name));
  });

  it('queries history by agent name', () => {
    const engine = new CastingEngine();
    const history = new CastingHistory();
    const config = { universe: 'usual-suspects' as const, requiredRoles: ['lead'] as AgentRole[] };
    const team = engine.castTeam(config);

    history.recordCast(team, config);

    const leadName = team.find(m => m.role === 'lead')!.name;
    const agentHistory = history.getAgentHistory(leadName);
    expect(agentHistory).toHaveLength(1);

    const noHistory = history.getAgentHistory('NonexistentAgent');
    expect(noHistory).toHaveLength(0);
  });
});
