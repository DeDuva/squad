/**
 * Tests for remote squad mode — squad link + squad init --mode remote (Issue #313)
 * Remote mode concept by @spboyer (Shayne Boyer), PR bradygaster/squad#131.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runLink } from '@squad/cli/commands/link';
import { writeRemoteConfig } from '@squad/cli/commands/init-remote';
import { resolveSquadPaths } from '@squad/sdk/resolution';

const TMP = join(process.cwd(), `.test-remote-mode-${randomBytes(4).toString('hex')}`);

function scaffold(...dirs: string[]): void {
  for (const d of dirs) {
    mkdirSync(join(TMP, d), { recursive: true });
  }
}

function readConfig(projectDir: string): Record<string, unknown> {
  const raw = readFileSync(join(projectDir, '.squad', 'config.json'), 'utf-8');
  return JSON.parse(raw);
}

describe('squad link', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('creates valid config.json with relative path', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'team-repo');
    scaffold('my-project/.git', 'team-repo/.squad');

    runLink(projectDir, teamDir);

    const config = readConfig(projectDir);
    expect(config.version).toBe(1);
    expect(config.teamRoot).toBe(relative(projectDir, teamDir));
    expect(config.projectKey).toBeNull();
  });

  it('fails gracefully when target does not exist', () => {
    const projectDir = join(TMP, 'my-project');
    scaffold('my-project/.git');

    expect(() => runLink(projectDir, join(TMP, 'nonexistent'))).toThrow(/does not exist/);
  });

  it('fails when target has no .squad/ directory', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'bare-repo');
    scaffold('my-project/.git', 'bare-repo');

    expect(() => runLink(projectDir, teamDir)).toThrow(/does not contain a \.squad\/ directory/);
  });

  it('config.json uses relative, not absolute paths', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'team-repo');
    scaffold('my-project/.git', 'team-repo/.squad');

    runLink(projectDir, teamDir);

    const config = readConfig(projectDir);
    expect(isAbsolute(config.teamRoot as string)).toBe(false);
  });

  it('accepts .ai-team/ in the target as a valid team root', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'legacy-team');
    scaffold('my-project/.git', 'legacy-team/.ai-team');

    runLink(projectDir, teamDir);

    const config = readConfig(projectDir);
    expect(config.version).toBe(1);
    expect(config.teamRoot).toBe(relative(projectDir, teamDir));
  });

  it('creates .squad/ directory if it does not exist', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'team-repo');
    scaffold('my-project/.git', 'team-repo/.squad');

    expect(existsSync(join(projectDir, '.squad'))).toBe(false);
    runLink(projectDir, teamDir);
    expect(existsSync(join(projectDir, '.squad'))).toBe(true);
  });

  // ---- Round-trip: link → resolveSquadPaths ----

  it('round-trip: link → resolveSquadPaths → gets remote mode with correct teamDir', () => {
    const projectDir = join(TMP, 'my-project');
    const teamDir = join(TMP, 'team-repo');
    scaffold('my-project/.git', 'my-project/.squad', 'team-repo/.squad');

    runLink(projectDir, teamDir);

    const resolved = resolveSquadPaths(projectDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.mode).toBe('remote');
    expect(resolved!.projectDir).toBe(join(projectDir, '.squad'));
    expect(resolved!.teamDir).toBe(teamDir);
  });
});

describe('writeRemoteConfig (init --mode remote)', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('writes config.json with relative teamRoot', () => {
    const projectDir = join(TMP, 'project');
    const teamDir = join(TMP, 'team');
    scaffold('project', 'team');

    writeRemoteConfig(projectDir, teamDir);

    const config = readConfig(projectDir);
    expect(config.version).toBe(1);
    expect(config.teamRoot).toBe(relative(projectDir, teamDir));
    expect(config.projectKey).toBeNull();
    expect(isAbsolute(config.teamRoot as string)).toBe(false);
  });

  it('creates .squad/ directory if missing', () => {
    const projectDir = join(TMP, 'project');
    scaffold('project');

    writeRemoteConfig(projectDir, '../team');

    expect(existsSync(join(projectDir, '.squad', 'config.json'))).toBe(true);
  });
});
