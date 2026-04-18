/**
 * M6-13: Release candidate build & validation tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createRelease,
  validateRelease,
  generateReleaseNotes,
  getReleaseChecklist,
  buildArtifact,
  computeSha256,
  type ReleaseConfig,
  type ReleaseManifest,
  type ReleaseChannel,
  type ReleaseArtifact,
  type ReleaseValidationError,
  type ReleaseChecklistItem,
} from '@squad/sdk/build';
import type { CommitInfo } from '@squad/sdk/build';

// ─── Helpers ────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(tmpdir(), 'squad-release-test-' + Date.now());

function makeConfig(overrides?: Partial<ReleaseConfig>): ReleaseConfig {
  return {
    version: '1.0.0-rc.1',
    channel: 'rc',
    prerelease: true,
    tag: 'v1.0.0-rc.1',
    ...overrides,
  };
}

function makeManifest(overrides?: Partial<ReleaseManifest>): ReleaseManifest {
  return {
    version: '1.0.0-rc.1',
    channel: 'rc',
    artifacts: [],
    timestamp: new Date().toISOString(),
    changelog: '# Changes\n\n- stuff\n',
    ...overrides,
  };
}

function makeArtifact(overrides?: Partial<ReleaseArtifact>): ReleaseArtifact {
  return {
    name: 'squad.js',
    path: '/dist/squad.js',
    size: 1024,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ─── computeSha256 ──────────────────────────────────────────────────────

describe('computeSha256', () => {
  it('should compute sha256 for a string', () => {
    const hash = computeSha256('hello');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should compute sha256 for a buffer', () => {
    const hash = computeSha256(Buffer.from('hello'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce consistent hashes', () => {
    expect(computeSha256('test')).toBe(computeSha256('test'));
  });

  it('should produce different hashes for different inputs', () => {
    expect(computeSha256('a')).not.toBe(computeSha256('b'));
  });
});

// ─── buildArtifact ──────────────────────────────────────────────────────

describe('buildArtifact', () => {
  it('should return null for non-existent file', () => {
    expect(buildArtifact('nope', join(FIXTURE_DIR, 'missing.js'))).toBeNull();
  });

  it('should build artifact from existing file', () => {
    const filePath = join(FIXTURE_DIR, 'bundle.js');
    writeFileSync(filePath, 'console.log("hello");');
    const artifact = buildArtifact('bundle.js', filePath);
    expect(artifact).not.toBeNull();
    expect(artifact!.name).toBe('bundle.js');
    expect(artifact!.size).toBeGreaterThan(0);
    expect(artifact!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── createRelease ──────────────────────────────────────────────────────

describe('createRelease', () => {
  it('should create a manifest with no artifacts', () => {
    const manifest = createRelease(makeConfig());
    expect(manifest.version).toBe('1.0.0-rc.1');
    expect(manifest.channel).toBe('rc');
    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.timestamp).toBeTruthy();
  });

  it('should pick up artifacts from existing files', () => {
    const f = join(FIXTURE_DIR, 'sdk.js');
    writeFileSync(f, 'export default {};');
    const manifest = createRelease(makeConfig(), { 'sdk.js': f });
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].name).toBe('sdk.js');
  });

  it('should skip non-existent artifact paths', () => {
    const manifest = createRelease(makeConfig(), { missing: '/nope/missing.js' });
    expect(manifest.artifacts).toHaveLength(0);
  });

  it('should use the config version and channel', () => {
    const config = makeConfig({ version: '2.0.0-beta.3', channel: 'beta' });
    const manifest = createRelease(config);
    expect(manifest.version).toBe('2.0.0-beta.3');
    expect(manifest.channel).toBe('beta');
  });
});

// ─── validateRelease ────────────────────────────────────────────────────

describe('validateRelease', () => {
  it('should return no errors for valid rc manifest', () => {
    const errors = validateRelease(makeManifest());
    const realErrors = errors.filter((e) => e.severity === 'error');
    expect(realErrors).toHaveLength(0);
  });

  it('should return no errors for valid stable manifest', () => {
    const errors = validateRelease(makeManifest({ version: '1.0.0', channel: 'stable' }));
    const realErrors = errors.filter((e) => e.severity === 'error');
    expect(realErrors).toHaveLength(0);
  });

  it('should flag missing version', () => {
    const errors = validateRelease(makeManifest({ version: '' }));
    expect(errors.some((e) => e.field === 'version' && e.severity === 'error')).toBe(true);
  });

  it('should flag invalid semver', () => {
    const errors = validateRelease(makeManifest({ version: 'bad' }));
    expect(errors.some((e) => e.message.includes('Invalid semver'))).toBe(true);
  });

  it('should flag stable channel with prerelease suffix', () => {
    const errors = validateRelease(makeManifest({ version: '1.0.0-rc.1', channel: 'stable' }));
    expect(errors.some((e) => e.message.includes('prerelease suffixes'))).toBe(true);
  });

  it('should warn about non-stable channel without prerelease suffix', () => {
    const errors = validateRelease(makeManifest({ version: '1.0.0', channel: 'rc' }));
    expect(errors.some((e) => e.severity === 'warning' && e.message.includes('prerelease suffix'))).toBe(true);
  });

  it('should flag missing timestamp', () => {
    const errors = validateRelease(makeManifest({ timestamp: '' }));
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('should flag invalid timestamp', () => {
    const errors = validateRelease(makeManifest({ timestamp: 'not-a-date' }));
    expect(errors.some((e) => e.message.includes('valid ISO date'))).toBe(true);
  });

  it('should flag artifact with missing name', () => {
    const errors = validateRelease(makeManifest({ artifacts: [makeArtifact({ name: '' })] }));
    expect(errors.some((e) => e.field.includes('name'))).toBe(true);
  });

  it('should flag artifact with invalid sha256', () => {
    const errors = validateRelease(makeManifest({ artifacts: [makeArtifact({ sha256: 'short' })] }));
    expect(errors.some((e) => e.message.includes('sha256'))).toBe(true);
  });

  it('should flag artifact with negative size', () => {
    const errors = validateRelease(makeManifest({ artifacts: [makeArtifact({ size: -1 })] }));
    expect(errors.some((e) => e.message.includes('non-negative'))).toBe(true);
  });

  it('should warn about duplicate artifact names', () => {
    const errors = validateRelease(
      makeManifest({ artifacts: [makeArtifact(), makeArtifact()] }),
    );
    expect(errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
  });

  it('should warn about empty changelog', () => {
    const errors = validateRelease(makeManifest({ changelog: '' }));
    expect(errors.some((e) => e.field === 'changelog' && e.severity === 'warning')).toBe(true);
  });
});

// ─── generateReleaseNotes ───────────────────────────────────────────────

describe('generateReleaseNotes', () => {
  const commits: CommitInfo[] = [
    { sha: 'abc1234567', message: 'feat: add benchmarks', author: 'fenster', date: '2025-01-01', type: 'feat' },
    { sha: 'def5678901', message: 'fix: routing crash', author: 'kujan', date: '2025-01-02', type: 'fix' },
    { sha: 'ghi9012345', message: 'docs: update README', author: 'verbal', date: '2025-01-03', type: 'docs' },
  ];

  it('should include version and date in heading', () => {
    const notes = generateReleaseNotes(makeManifest(), commits);
    expect(notes).toContain('1.0.0-rc.1');
    expect(notes).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('should include channel badge for non-stable releases', () => {
    const notes = generateReleaseNotes(makeManifest({ channel: 'beta', version: '1.0.0-beta.1' }), commits);
    expect(notes).toContain('BETA');
  });

  it('should not include channel badge for stable releases', () => {
    const notes = generateReleaseNotes(makeManifest({ channel: 'stable', version: '1.0.0' }), commits);
    expect(notes).not.toContain('STABLE');
  });

  it('should group features and fixes', () => {
    const notes = generateReleaseNotes(makeManifest(), commits);
    expect(notes).toContain('Features');
    expect(notes).toContain('Bug Fixes');
    expect(notes).toContain('add benchmarks');
    expect(notes).toContain('routing crash');
  });

  it('should include short commit SHA', () => {
    const notes = generateReleaseNotes(makeManifest(), commits);
    expect(notes).toContain('abc1234');
  });

  it('should include breaking changes section', () => {
    const breakingCommits: CommitInfo[] = [
      { sha: 'zzz0000000', message: 'feat!: remove old API', author: 'fenster', date: '2025-01-01', type: 'feat' },
    ];
    const notes = generateReleaseNotes(makeManifest(), breakingCommits);
    expect(notes).toContain('Breaking Changes');
  });

  it('should include artifacts table when present', () => {
    const manifest = makeManifest({ artifacts: [makeArtifact()] });
    const notes = generateReleaseNotes(manifest, []);
    expect(notes).toContain('Artifacts');
    expect(notes).toContain('squad.js');
    expect(notes).toContain('SHA-256');
  });

  it('should return valid markdown', () => {
    const notes = generateReleaseNotes(makeManifest(), commits);
    expect(notes.startsWith('#')).toBe(true);
    expect(notes.endsWith('\n')).toBe(true);
  });
});

// ─── getReleaseChecklist ────────────────────────────────────────────────

describe('getReleaseChecklist', () => {
  it('should return checklist items', () => {
    const items = getReleaseChecklist(makeManifest());
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('name');
    expect(items[0]).toHaveProperty('check');
    expect(items[0]).toHaveProperty('required');
    expect(items[0]).toHaveProperty('status');
  });

  it('should evaluate items against a valid manifest', () => {
    const items = getReleaseChecklist(makeManifest({ artifacts: [makeArtifact()] }));
    const requiredItems = items.filter((i) => i.required);
    expect(requiredItems.every((i) => i.status === 'pass')).toBe(true);
  });

  it('should fail version check for invalid version', () => {
    const items = getReleaseChecklist(makeManifest({ version: 'bad' }));
    const versionItem = items.find((i) => i.name.includes('semver'));
    expect(versionItem?.status).toBe('fail');
  });

  it('should fail when no manifest is provided', () => {
    const items = getReleaseChecklist();
    expect(items.every((i) => i.status === 'fail')).toBe(true);
  });

  it('should check channel-version consistency', () => {
    const items = getReleaseChecklist(makeManifest({ channel: 'stable', version: '1.0.0' }));
    const matchItem = items.find((i) => i.name.includes('channel'));
    expect(matchItem?.status).toBe('pass');
  });

  it('should fail channel-version check for mismatch', () => {
    const items = getReleaseChecklist(makeManifest({ channel: 'stable', version: '1.0.0-rc.1' }));
    const matchItem = items.find((i) => i.name.includes('channel'));
    expect(matchItem?.status).toBe('fail');
  });
});
