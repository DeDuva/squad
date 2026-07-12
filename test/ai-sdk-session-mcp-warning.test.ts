/**
 * Tests for console.warn when mcpServers is configured.
 *
 * AiSdkSession does not implement MCP transport (same as GeminiSession).
 * When mcpServers is provided, the session should emit a console.warn.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkSession } from '../packages/squad-sdk/dist/adapter/ai-sdk-session.js';
import type { SquadSessionConfig } from '@deduvafork/squad-sdk/adapter';

const dummyModel = new MockLanguageModelV4({});

describe('AiSdkSession — mcpServers warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs console.warn when mcpServers is provided in config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new AiSdkSession(
      'google',
      'fake-key',
      {
        mcpServers: {
          github: { type: 'local', command: 'node', args: ['./github-mcp.js'], tools: ['*'] },
        },
      } as unknown as SquadSessionConfig,
      dummyModel,
    );

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('[squad-sdk]');
    expect(warnSpy.mock.calls[0][0]).toContain('mcpServers');
    expect(warnSpy.mock.calls[0][0]).toContain('not yet implemented');
  });

  it('does not warn when mcpServers is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new AiSdkSession('google', 'fake-key', {} as SquadSessionConfig, dummyModel);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when mcpServers is an empty object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new AiSdkSession('google', 'fake-key', { mcpServers: {} } as SquadSessionConfig, dummyModel);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
