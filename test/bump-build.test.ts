import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'bump-build.mjs');

/**
 * Helper: create a temp workspace with 3 package.json files mirroring the real repo layout.
 */
function makeTempWorkspace(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'bump-build-'));
  const paths = [
    join(dir, 'package.json'),
    join(dir, 'packages', 'squad-sdk', 'package.json'),
    join(dir, 'packages', 'squad-cli', 'package.json'),
  ];
  mkdirSync(join(dir, 'packages', 'squad-sdk'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'squad-cli'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });

  // Copy the real script but patch __dirname to point at temp
  const scriptSrc = readFileSync(SCRIPT, 'utf8');
  const patched = scriptSrc.replace(
    "const root = join(__dirname, '..');",
    `const root = ${JSON.stringify(dir)};`
  );
  writeFileSync(join(dir, 'scripts', 'bump-build.mjs'), patched, 'utf8');

  for (const p of paths) {
    writeFileSync(p, JSON.stringify({ name: 'test', version }, null, 2) + '\n');
  }
  return { dir, paths };
}

function readVersion(path: string): string {
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

describe('bump-build.mjs', () => {
  let workspace: { dir: string; paths: string[] };

  // In CI, process.env.CI='true' causes the bump script to skip.
  // Override env to unset CI so the script actually runs.
  const execOpts = { stdio: 'pipe' as const, env: { ...process.env, CI: '', SKIP_BUILD_BUMP: '' } };

  afterEach(() => {
    if (workspace) rmSync(workspace.dir, { recursive: true, force: true });
  });

  it('adds build number .1 when starting from x.y.z-preview', () => {
    workspace = makeTempWorkspace('0.8.6-preview');
    execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
    for (const p of workspace.paths) {
      expect(readVersion(p)).toBe('0.8.6-preview.1');
    }
  });

  it('increments existing build number', () => {
    workspace = makeTempWorkspace('0.8.6-preview.5');
    execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
    for (const p of workspace.paths) {
      expect(readVersion(p)).toBe('0.8.6-preview.6');
    }
  });

  it('handles version without prerelease tag', () => {
    workspace = makeTempWorkspace('1.0.0.3');
    execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
    for (const p of workspace.paths) {
      // Old 4-part format (1.0.0.3) is parsed as base=1.0.0, build=3
      // New format uses valid semver prerelease tag, and specifically the
      // "preview" tag — the CI Prerelease Version Guard rejects every tag
      // except preview/insider, so a "-build" tag here would generate a
      // version that cannot be merged.
      expect(readVersion(p)).toBe('1.0.0-preview.4');
    }
  });

  it('bumps clean release version to semver prerelease format', () => {
    workspace = makeTempWorkspace('1.0.0');
    execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
    for (const p of workspace.paths) {
      expect(readVersion(p)).toBe('1.0.0-preview.1');
    }
  });

  it('only ever emits versions the CI version guard accepts', () => {
    // Regression guard for the -build.N bug: a bare X.Y.Z used to bump to
    // X.Y.Z-build.1, which the guard rejects, and because -build then parses
    // as the prerelease tag every later bump preserved it, so the tree could
    // never recover on its own.
    const GUARD = /^\d+\.\d+\.\d+(-(preview|insider)(\.\d+)?)?$/;
    for (const start of ['1.0.0', '1.0.0.3', '1.0.0-preview', '1.0.0-preview.2', '1.0.0-insider.5']) {
      workspace = makeTempWorkspace(start);
      execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
      const bumped = readVersion(workspace.paths[0]!);
      expect(bumped, `${start} bumped to unmergeable ${bumped}`).toMatch(GUARD);
      // afterEach only removes the last workspace this test assigned, so each
      // iteration cleans up its own temp dir.
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  it('keeps all 3 package.json files in sync', () => {
    workspace = makeTempWorkspace('0.8.6-preview');
    execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, execOpts);
    const versions = workspace.paths.map(readVersion);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBe('0.8.6-preview.1');
  });

  it('outputs the build transition to stdout', () => {
    workspace = makeTempWorkspace('0.8.6-preview');
    const output = execSync(`node ${join(workspace.dir, 'scripts', 'bump-build.mjs')}`, { ...execOpts, encoding: 'utf8' });
    expect(output.trim()).toBe('Build 1: 0.8.6-preview → 0.8.6-preview.1');
  });
});
