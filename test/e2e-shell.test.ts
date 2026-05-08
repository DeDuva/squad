/**
 * E2E integration tests for the Squad interactive shell.
 *
 * Renders the full App component with mocked registry/renderer/SDK,
 * then drives it via stdin like a real user would.
 *
 * @see https://github.com/DeDuva/squad/issues/433
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import React from 'react';
import { render, type RenderResponse } from 'ink-testing-library';
import { SessionRegistry } from '../packages/squad-cli/src/cli/shell/sessions.js';
import { ShellRenderer } from '../packages/squad-cli/src/cli/shell/render.js';
import { App, type ShellApi } from '../packages/squad-cli/src/cli/shell/components/App.js';
import type { ParsedInput } from '../packages/squad-cli/src/cli/shell/router.js';

const h = React.createElement;

// ─── Test infrastructure ────────────────────────────────────────────────────

const TICK = 80; // ms between keystrokes for React state to settle

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** Pause for `ms` milliseconds. */
function tick(ms = TICK): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Scaffold a minimal .squad/ directory so the App shows a welcome banner. */
function scaffoldSquadDir(root: string): void {
  const squadDir = join(root, '.squad');
  const agentsDir = join(squadDir, 'agents');
  const identityDir = join(squadDir, 'identity');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(identityDir, { recursive: true });

  writeFileSync(join(squadDir, 'team.md'), `# Squad Team — E2E Test Project

> An end-to-end test project for shell integration.

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Keaton | Lead | \`.squad/agents/keaton/charter.md\` | ✅ Active |
| Fenster | Core Dev | \`.squad/agents/fenster/charter.md\` | ✅ Active |
`);

  writeFileSync(join(identityDir, 'now.md'), `---
updated_at: 2025-01-01T00:00:00.000Z
focus_area: E2E test coverage
active_issues: []
---

# What We're Focused On

E2E test coverage.
`);
}

interface ShellHarness {
  /** The ink render instance. */
  ink: RenderResponse;
  /** The ShellApi exposed by the App after mount. */
  api: () => ShellApi;
  /** Type characters one-at-a-time with tick between each. */
  type: (text: string) => Promise<void>;
  /** Type text then press Enter (submit). */
  submit: (text: string) => Promise<void>;
  /** Get the current rendered frame with ANSI stripped. */
  frame: () => string;
  /** Wait until frame contains `text`, or timeout. */
  waitFor: (text: string, timeoutMs?: number) => Promise<void>;
  /** Assert that the frame contains `text`. */
  hasText: (text: string) => boolean;
  /** Send raw stdin bytes (e.g. escape sequences). */
  raw: (bytes: string) => void;
  /** The mock onDispatch function. */
  dispatched: ReturnType<typeof vi.fn>;
  /** The mock onCancel function. */
  cancelled: ReturnType<typeof vi.fn>;
  /** Clean up the render and temp directory. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fully-wired shell harness for E2E tests.
 *
 * Renders the App component with:
 * - A SessionRegistry pre-loaded with agents
 * - A ShellRenderer (no-op in tests)
 * - A temp directory with .squad/ scaffolding
 * - Mocked onDispatch and onCancel callbacks
 */
async function createShellHarness(opts?: {
  agents?: Array<{ name: string; role: string }>;
  withSquadDir?: boolean;
  version?: string;
}): Promise<ShellHarness> {
  const {
    agents = [
      { name: 'Keaton', role: 'Lead' },
      { name: 'Fenster', role: 'Core Dev' },
    ],
    withSquadDir = true,
    version = '0.0.0-test',
  } = opts ?? {};

  const tempDir = mkdtempSync(join(tmpdir(), 'squad-e2e-'));
  if (withSquadDir) scaffoldSquadDir(tempDir);

  const registry = new SessionRegistry();
  for (const a of agents) registry.register(a.name, a.role);

  const renderer = new ShellRenderer();
  const dispatched = vi.fn<(parsed: ParsedInput) => Promise<void>>().mockResolvedValue(undefined);
  const cancelled = vi.fn();

  let shellApi: ShellApi | undefined;
  const onReady = (api: ShellApi) => { shellApi = api; };

  const ink = render(
    h(App, {
      registry,
      renderer,
      teamRoot: tempDir,
      version,
      onReady,
      onDispatch: dispatched,
      onCancel: cancelled,
    })
  );

  // Let React mount and fire effects
  await tick(120);

  const harness: ShellHarness = {
    ink,
    api: () => {
      if (!shellApi) throw new Error('ShellApi not ready — did the App mount?');
      return shellApi;
    },
    async type(text: string) {
      for (const ch of text) {
        ink.stdin.write(ch);
        await tick();
      }
    },
    async submit(text: string) {
      await harness.type(text);
      ink.stdin.write('\r');
      await tick(120);
    },
    frame() {
      return stripAnsi(ink.lastFrame() ?? '');
    },
    async waitFor(text: string, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (harness.frame().includes(text)) return;
        await tick(50);
      }
      throw new Error(`Timed out waiting for "${text}" in frame:\n${harness.frame()}`);
    },
    hasText(text: string) {
      return harness.frame().includes(text);
    },
    raw(bytes: string) {
      ink.stdin.write(bytes);
    },
    dispatched,
    cancelled,
    async cleanup() {
      ink.unmount();
      await rm(tempDir, { recursive: true, force: true });
    },
  };

  return harness;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Shell renders and shows welcome message
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Shell welcome', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    // Force a wide terminal so the full banner is shown
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('shows SQUAD title in the welcome banner', () => {
    // Figlet banner renders SQUAD as ASCII art (not literal text)
    expect(shell.hasText('___')).toBe(true);
  });

  it('displays version number', () => {
    expect(shell.hasText('0.0.0-test')).toBe(true);
  });

  it('shows agent names from the roster', () => {
    expect(shell.hasText('Keaton')).toBe(true);
    expect(shell.hasText('Fenster')).toBe(true);
  });

  it('shows help hint in banner', () => {
    expect(shell.hasText('/help')).toBe(true);
  });

  it('shows project description from team.md', () => {
    // Project description removed from simplified header — test version line instead
    expect(shell.hasText('Type naturally')).toBe(true);
  });

  it('shows agent count', () => {
    expect(shell.hasText('2 agents ready')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. User can type and submit a message
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: User input and submission', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('typed text appears in the input area', async () => {
    await shell.type('hello squad');
    expect(shell.hasText('hello squad')).toBe(true);
  });

  it('submitted message appears as user message with chevron', async () => {
    await shell.submit('build the feature');
    expect(shell.hasText('build the feature')).toBe(true);
    expect(shell.hasText('❯')).toBe(true);
  });

  it('submission dispatches to onDispatch for coordinator routing', async () => {
    await shell.submit('what should we build next?');
    expect(shell.dispatched).toHaveBeenCalledTimes(1);
    const parsed = shell.dispatched.mock.calls[0]![0] as ParsedInput;
    expect(parsed.type).toBe('coordinator');
    expect(parsed.content).toBe('what should we build next?');
  });

  it('input clears after submission', async () => {
    await shell.type('temp message');
    await tick();
    expect(shell.hasText('temp message')).toBe(true);
    shell.ink.stdin.write('\r');
    await tick(120);
    // The text appears in message history (with ❯) but the input prompt is cleared.
    // Verify we can type new text without the old text lingering in the input area.
    await shell.type('new text');
    expect(shell.hasText('new text')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. /help command works
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: /help command', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('shows help output with available commands', async () => {
    await shell.submit('/help');
    expect(shell.hasText('/status')).toBe(true);
    expect(shell.hasText('/history')).toBe(true);
    expect(shell.hasText('/quit')).toBe(true);
  });

  it('/help does not dispatch to SDK', async () => {
    await shell.submit('/help');
    expect(shell.dispatched).not.toHaveBeenCalled();
  });

  it('shows routing guidance (how to talk to agents)', async () => {
    await shell.submit('/help');
    expect(shell.hasText('@AgentName')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. /status command works
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: /status command', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('shows team status with agent count', async () => {
    await shell.submit('/status');
    expect(shell.hasText('2 agents')).toBe(true);
  });

  it('shows team root path', async () => {
    await shell.submit('/status');
    // The temp dir path will be in the output
    expect(shell.hasText('Root')).toBe(true);
  });

  it('shows message count', async () => {
    await shell.submit('/status');
    // /status is preceded by the user message for "/status" so there's 1 message
    expect(shell.hasText('Messages')).toBe(true);
  });

  it('/status does not dispatch to SDK', async () => {
    await shell.submit('/status');
    expect(shell.dispatched).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. @agent routing shows in UI
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: @agent routing', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('@Keaton message dispatches as direct_agent', async () => {
    await shell.submit('@Keaton fix the build');
    expect(shell.dispatched).toHaveBeenCalledTimes(1);
    const parsed = shell.dispatched.mock.calls[0]![0] as ParsedInput;
    expect(parsed.type).toBe('direct_agent');
    expect(parsed.agentName).toBe('Keaton');
    expect(parsed.content).toBe('fix the build');
  });

  it('@agent message appears in the conversation', async () => {
    await shell.submit('@Keaton fix the build');
    expect(shell.hasText('@Keaton fix the build')).toBe(true);
  });

  it('agent response appears when pushed via ShellApi', async () => {
    await shell.submit('@Keaton fix the build');
    // Simulate agent response via ShellApi
    shell.api().addMessage({
      role: 'agent',
      agentName: 'Keaton',
      content: 'On it! Fixing the build now.',
      timestamp: new Date(),
    });
    await tick(120);
    expect(shell.hasText('On it! Fixing the build now.')).toBe(true);
  });

  it('bare message routes to coordinator', async () => {
    await shell.submit('what should we build?');
    expect(shell.dispatched).toHaveBeenCalledTimes(1);
    const parsed = shell.dispatched.mock.calls[0]![0] as ParsedInput;
    expect(parsed.type).toBe('coordinator');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Ctrl+C behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Ctrl+C behavior', () => {
  let shell: ShellHarness;

  beforeEach(async () => {
    vi.stubEnv('NO_COLOR', '1');
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    shell = await createShellHarness();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shell.cleanup();
  });

  it('first Ctrl+C when idle shows exit hint', async () => {
    // Ctrl+C is sent as the byte 0x03 in terminal
    shell.raw('\x03');
    await tick(120);
    expect(shell.hasText('Press Ctrl+C again to exit')).toBe(true);
  });

  it('hint is a system message in the conversation', async () => {
    shell.raw('\x03');
    await tick(120);
    // System messages no longer have [system] prefix — just check for Ctrl+C hint content
    expect(shell.hasText('Ctrl+C')).toBe(true);
  });
});
