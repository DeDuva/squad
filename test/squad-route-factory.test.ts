/**
 * Tests for Phase 3: squad_route with sessionFactory.
 *
 * Verifies that the tool calls the provided factory with correct arguments,
 * returns a success result containing the new sessionId, handles factory
 * errors gracefully, and fails (not succeeds) when no factory is configured.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '@deduvafork/squad-sdk/tools';
import type { RouteRequest, AgentSessionFactory } from '@deduvafork/squad-sdk/tools';

describe('squad_route — with sessionFactory', () => {
  const invocationCtx = {
    sessionId: 'caller-session',
    toolCallId: 'call-1',
    toolName: 'squad_route',
    arguments: {},
  };

  it('calls sessionFactory with targetAgent, task, priority, and context', async () => {
    const factory: AgentSessionFactory = vi.fn().mockResolvedValue({ sessionId: 'new-session-42' });
    const registry = new ToolRegistry('.test-squad', undefined, undefined, undefined, factory);
    const tool = registry.getTool('squad_route')!;

    await tool.handler(
      {
        targetAgent: 'fenster',
        task: 'Implement the login page',
        priority: 'high',
        context: 'Relates to PRD-3',
      } as RouteRequest,
      invocationCtx,
    );

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith('fenster', 'Implement the login page', 'high', 'Relates to PRD-3');
  });

  it('returns success result containing the new sessionId', async () => {
    const factory: AgentSessionFactory = vi.fn().mockResolvedValue({ sessionId: 'new-session-42' });
    const registry = new ToolRegistry('.test-squad', undefined, undefined, undefined, factory);
    const tool = registry.getTool('squad_route')!;

    const result = await tool.handler(
      { targetAgent: 'fenster', task: 'Do a thing' } as RouteRequest,
      invocationCtx,
    );

    expect(result).toMatchObject({ resultType: 'success' });
    expect((result as any).textResultForLlm).toContain('new-session-42');
    expect((result as any).textResultForLlm).toContain('fenster');
    expect((result as any).toolTelemetry.sessionId).toBe('new-session-42');
  });

  it('defaults priority to normal when not specified', async () => {
    const factory: AgentSessionFactory = vi.fn().mockResolvedValue({ sessionId: 's1' });
    const registry = new ToolRegistry('.test-squad', undefined, undefined, undefined, factory);
    const tool = registry.getTool('squad_route')!;

    await tool.handler({ targetAgent: 'fenster', task: 'Do a thing' } as RouteRequest, invocationCtx);

    expect(factory).toHaveBeenCalledWith('fenster', 'Do a thing', 'normal', undefined);
  });

  it('returns failure when sessionFactory throws', async () => {
    const factory: AgentSessionFactory = vi.fn().mockRejectedValue(new Error('pool at capacity'));
    const registry = new ToolRegistry('.test-squad', undefined, undefined, undefined, factory);
    const tool = registry.getTool('squad_route')!;

    const result = await tool.handler(
      { targetAgent: 'fenster', task: 'Do a thing' } as RouteRequest,
      invocationCtx,
    );

    expect(result).toMatchObject({ resultType: 'failure' });
    expect((result as any).textResultForLlm).toContain('Failed to route task');
  });

  it('returns failure (not success) when no sessionFactory is configured', async () => {
    const registry = new ToolRegistry('.test-squad');
    const tool = registry.getTool('squad_route')!;

    const result = await tool.handler(
      { targetAgent: 'fenster', task: 'Do a thing' } as RouteRequest,
      invocationCtx,
    );

    expect(result).toMatchObject({
      resultType: 'failure',
      error: 'sessionFactory not configured',
    });
  });

  it('still validates that targetAgent is required when factory is present', async () => {
    const factory: AgentSessionFactory = vi.fn().mockResolvedValue({ sessionId: 's1' });
    const registry = new ToolRegistry('.test-squad', undefined, undefined, undefined, factory);
    const tool = registry.getTool('squad_route')!;

    const result = await tool.handler(
      { targetAgent: '', task: 'Do a thing' } as RouteRequest,
      invocationCtx,
    );

    expect(result).toMatchObject({ resultType: 'failure', error: 'Invalid target agent' });
    expect(factory).not.toHaveBeenCalled();
  });
});
