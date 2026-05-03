/**
 * Tests for RalphMonitor — Work Monitor (PRD 8)
 *
 * Covers:
 * - start/stop lifecycle
 * - Event tracking (session created/destroyed)
 * - Health check (stale session detection)
 * - getStatus() returns current agent work statuses
 *
 * NOTE: RalphMonitor is a partial stub (TODOs for event subscriptions
 * and persistence). Tests validate current behavior and document
 * expected behavior once implementations land.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RalphMonitor,
  type MonitorConfig,
  type AgentWorkStatus,
} from '../packages/squad-sdk/src/ralph/index.js';

// --- Mock EventBus ---

function createMockEventBus() {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const allHandlers = new Set<(event: any) => void>();

  return {
    subscribe(type: string, handler: (event: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => { handlers.get(type)?.delete(handler); };
    },
    subscribeAll(handler: (event: any) => void) {
      allHandlers.add(handler);
      return () => { allHandlers.delete(handler); };
    },
    async emit(event: any) {
      const typeHandlers = handlers.get(event.type);
      if (typeHandlers) {
        for (const h of typeHandlers) h(event);
      }
      for (const h of allHandlers) h(event);
    },
    clear() {
      handlers.clear();
      allHandlers.clear();
    },
    // Expose for test inspection
    _handlers: handlers,
    _allHandlers: allHandlers,
  } as any;
}

// --- Helpers ---

function makeConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    teamRoot: '/test/team',
    healthCheckInterval: 5000,
    staleSessionThreshold: 10000,
    ...overrides,
  };
}

// =============================================================================
// RalphMonitor Tests
// =============================================================================

describe('RalphMonitor', () => {
  let monitor: RalphMonitor;

  beforeEach(() => {
    monitor = new RalphMonitor(makeConfig());
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('creates monitor with config', () => {
      expect(monitor).toBeDefined();
    });

    it('initializes with empty status', () => {
      const status = monitor.getStatus();
      expect(status).toEqual([]);
    });
  });

  // --- start/stop lifecycle ---

  describe('start()', () => {
    it('accepts an EventBus and does not throw', async () => {
      const eventBus = createMockEventBus();
      await expect(monitor.start(eventBus)).resolves.toBeUndefined();
    });

    it('can be called multiple times without error', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      await expect(monitor.start(eventBus)).resolves.toBeUndefined();
    });
  });

  describe('stop()', () => {
    it('does not throw when stopped before start', async () => {
      await expect(monitor.stop()).resolves.toBeUndefined();
    });

    it('does not throw after start', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      await expect(monitor.stop()).resolves.toBeUndefined();
    });

    it('can be called multiple times safely', async () => {
      await monitor.stop();
      await expect(monitor.stop()).resolves.toBeUndefined();
    });
  });

  describe('start → stop lifecycle', () => {
    it('completes full start → stop cycle', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      await monitor.stop();
      expect(monitor.getStatus()).toEqual([]);
    });
  });

  // --- getStatus() ---

  describe('getStatus()', () => {
    it('returns empty array initially', () => {
      expect(monitor.getStatus()).toEqual([]);
    });

    it('returns array type', () => {
      const result = monitor.getStatus();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // --- healthCheck() ---

  describe('healthCheck()', () => {
    it('returns empty array when no agents tracked', async () => {
      const result = await monitor.healthCheck();
      expect(result).toEqual([]);
    });

    it('returns AgentWorkStatus array', async () => {
      const result = await monitor.healthCheck();
      expect(Array.isArray(result)).toBe(true);
    });

    it('can be called multiple times', async () => {
      const result1 = await monitor.healthCheck();
      const result2 = await monitor.healthCheck();
      expect(result1).toEqual([]);
      expect(result2).toEqual([]);
    });

    it('works after start()', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      const result = await monitor.healthCheck();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // --- event handling ---

  describe('event handling', () => {
    it('tracks agent on session:created', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);

      await eventBus.emit({
        type: 'session:created',
        sessionId: 'test-session-1',
        agentName: 'Fenster',
        payload: null,
        timestamp: new Date(),
      });

      const status = monitor.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].agentName).toBe('Fenster');
      expect(status[0].status).toBe('working');
      expect(status[0].sessionId).toBe('test-session-1');
    });

    it('removes agent on session:destroyed', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);

      await eventBus.emit({ type: 'session:created', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date() });
      expect(monitor.getStatus()).toHaveLength(1);

      await eventBus.emit({ type: 'session:destroyed', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date() });
      expect(monitor.getStatus()).toHaveLength(0);
    });

    it('marks agent error on session:error', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);

      await eventBus.emit({ type: 'session:created', sessionId: 's1', agentName: 'Hockney', payload: null, timestamp: new Date() });
      await eventBus.emit({ type: 'session:error', sessionId: 's1', agentName: 'Hockney', payload: { message: 'timeout' }, timestamp: new Date() });

      const status = monitor.getStatus();
      expect(status[0].status).toBe('error');
    });

    it('records milestones on agent:milestone', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);

      await eventBus.emit({ type: 'session:created', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date() });
      await eventBus.emit({ type: 'agent:milestone', sessionId: 's1', agentName: 'Fenster', payload: { milestone: 'tests passing', task: 'refactoring' }, timestamp: new Date() });

      const status = monitor.getStatus();
      expect(status[0].milestones).toContain('tests passing');
      expect(status[0].currentTask).toBe('refactoring');
    });

    it('detects stale agents in healthCheck', async () => {
      const config = makeConfig({ staleSessionThreshold: 100 });
      const m = new RalphMonitor(config);
      const eventBus = createMockEventBus();
      await m.start(eventBus);

      await eventBus.emit({ type: 'session:created', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date(Date.now() - 200) });

      const result = await m.healthCheck();
      expect(result[0].status).toBe('stale');

      await m.stop();
    });

    it('tracks multiple agents independently', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);

      await eventBus.emit({ type: 'session:created', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date() });
      await eventBus.emit({ type: 'session:created', sessionId: 's2', agentName: 'Hockney', payload: null, timestamp: new Date() });

      expect(monitor.getStatus()).toHaveLength(2);

      await eventBus.emit({ type: 'session:destroyed', sessionId: 's1', agentName: 'Fenster', payload: null, timestamp: new Date() });
      const remaining = monitor.getStatus();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].agentName).toBe('Hockney');
    });
  });

  // --- Config ---

  describe('config', () => {
    it('accepts custom health check interval', () => {
      const m = new RalphMonitor(makeConfig({ healthCheckInterval: 60000 }));
      expect(m).toBeDefined();
    });

    it('accepts custom stale session threshold', () => {
      const m = new RalphMonitor(makeConfig({ staleSessionThreshold: 600000 }));
      expect(m).toBeDefined();
    });

    it('accepts optional statePath', () => {
      const m = new RalphMonitor(makeConfig({ statePath: '/tmp/ralph-state.json' }));
      expect(m).toBeDefined();
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('healthCheck after stop does not throw', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      await monitor.stop();
      await expect(monitor.healthCheck()).resolves.toEqual([]);
    });

    it('getStatus after stop returns empty', async () => {
      const eventBus = createMockEventBus();
      await monitor.start(eventBus);
      await monitor.stop();
      expect(monitor.getStatus()).toEqual([]);
    });
  });
});
