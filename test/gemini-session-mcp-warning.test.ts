/**
 * Tests for Phase 4B: console.warn when mcpServers is configured.
 *
 * GeminiSession does not implement MCP transport. When mcpServers is
 * provided, the session should emit a console.warn to alert the caller.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiSession } from '../packages/squad-sdk/dist/adapter/gemini-client.js';
import type { SquadSessionConfig } from '@bradygaster/squad-sdk/adapter';

describe('GeminiSession — mcpServers warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs console.warn when mcpServers is provided in config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new GeminiSession('fake-key', {
      mcpServers: {
        github: { type: 'local', command: 'node', args: ['./github-mcp.js'], tools: ['*'] },
      },
    } as unknown as SquadSessionConfig);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('[squad-sdk]');
    expect(warnSpy.mock.calls[0][0]).toContain('mcpServers');
    expect(warnSpy.mock.calls[0][0]).toContain('not yet implemented');
  });

  it('does not warn when mcpServers is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new GeminiSession('fake-key', {} as SquadSessionConfig);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when mcpServers is an empty object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new GeminiSession('fake-key', { mcpServers: {} } as SquadSessionConfig);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
