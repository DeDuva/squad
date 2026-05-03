/**
 * Tests for DirectResponseHandler (M3-6, Issue #147)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DirectResponseHandler,
  type CoordinatorContext,
  type DirectResponsePattern,
} from '@deduvafork/squad-sdk/coordinator';
import { DEFAULT_CONFIG, type SquadConfig } from '@deduvafork/squad-sdk/runtime';
import { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';

// --- Helpers ---

function makeContext(overrides: Partial<CoordinatorContext> = {}): CoordinatorContext {
  return {
    sessionId: 'ctx-1',
    config: DEFAULT_CONFIG,
    activeAgents: ['fenster', 'verbal', 'scribe'],
    ...overrides,
  };
}

// =============================================================================
// DirectResponseHandler Tests
// =============================================================================

describe('DirectResponseHandler', () => {
  let handler: DirectResponseHandler;

  beforeEach(() => {
    handler = new DirectResponseHandler();
  });

  // --- shouldHandleDirectly ---

  describe('shouldHandleDirectly', () => {
    it('returns true for "help"', () => {
      expect(handler.shouldHandleDirectly('help')).toBe(true);
    });

    it('returns true for "status"', () => {
      expect(handler.shouldHandleDirectly('status')).toBe(true);
    });

    it('returns true for "hello"', () => {
      expect(handler.shouldHandleDirectly('hello')).toBe(true);
    });

    it('returns true for "show team"', () => {
      expect(handler.shouldHandleDirectly('show team')).toBe(true);
    });

    it('returns true for "show config"', () => {
      expect(handler.shouldHandleDirectly('show config')).toBe(true);
    });

    it('returns true for "?"', () => {
      expect(handler.shouldHandleDirectly('?')).toBe(true);
    });

    it('returns false for complex tasks', () => {
      expect(handler.shouldHandleDirectly('implement auth module with JWT')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(handler.shouldHandleDirectly('')).toBe(false);
    });

    it('returns false for whitespace only', () => {
      expect(handler.shouldHandleDirectly('   ')).toBe(false);
    });

    it('returns true for "What can you do"', () => {
      expect(handler.shouldHandleDirectly('What can you do')).toBe(true);
    });

    it('returns true for "who is active"', () => {
      expect(handler.shouldHandleDirectly('who is active')).toBe(true);
    });

    it('returns true for "which model"', () => {
      expect(handler.shouldHandleDirectly('which model')).toBe(true);
    });

    it('returns true for "squad status"', () => {
      expect(handler.shouldHandleDirectly('squad status')).toBe(true);
    });
  });

  // --- handleDirect ---

  describe('handleDirect — status', () => {
    it('reports active agents', () => {
      const result = handler.handleDirect('status', makeContext());
      expect(result.category).toBe('status');
      expect(result.confidence).toBe('high');
      expect(result.response).toContain('fenster');
      expect(result.response).toContain('verbal');
    });

    it('reports no agents when none active', () => {
      const result = handler.handleDirect('status', makeContext({ activeAgents: [] }));
      expect(result.response).toContain('No agents');
    });

    it('matches "list agents"', () => {
      const result = handler.handleDirect('list agents', makeContext());
      expect(result.category).toBe('status');
    });

    it('matches "who is running"', () => {
      const result = handler.handleDirect("who's running", makeContext());
      expect(result.category).toBe('status');
    });
  });

  describe('handleDirect — help', () => {
    it('returns help text', () => {
      const result = handler.handleDirect('help', makeContext());
      expect(result.category).toBe('help');
      expect(result.response).toContain('Squad Coordinator');
    });

    it('matches "what can you do"', () => {
      const result = handler.handleDirect('what can you do', makeContext());
      expect(result.category).toBe('help');
    });

    it('matches "?"', () => {
      const result = handler.handleDirect('?', makeContext());
      expect(result.category).toBe('help');
    });
  });

  describe('handleDirect — config', () => {
    it('returns config summary', () => {
      const result = handler.handleDirect('show config', makeContext());
      expect(result.category).toBe('config');
      expect(result.response).toContain('Configuration');
      expect(result.response).toContain(DEFAULT_CONFIG.models.defaultModel);
    });

    it('matches "which model"', () => {
      const result = handler.handleDirect('which model am I using', makeContext());
      expect(result.category).toBe('config');
    });

    it('matches "config"', () => {
      const result = handler.handleDirect('config', makeContext());
      expect(result.category).toBe('config');
    });
  });

  describe('handleDirect — roster', () => {
    it('returns team roster content when available', () => {
      const result = handler.handleDirect('show team', makeContext({
        teamRoster: '## Team\n- Fenster: Core Dev\n- Verbal: Docs',
      }));
      expect(result.category).toBe('roster');
      expect(result.response).toContain('Fenster');
    });

    it('falls back to agent list when no roster', () => {
      const result = handler.handleDirect('show team', makeContext({ teamRoster: undefined }));
      expect(result.category).toBe('roster');
      expect(result.response).toContain('fenster');
    });

    it('reports no roster when no agents', () => {
      const result = handler.handleDirect('roster', makeContext({
        teamRoster: undefined,
        activeAgents: [],
      }));
      expect(result.response).toContain('No team roster');
    });

    it('matches "team"', () => {
      const result = handler.handleDirect('team', makeContext());
      expect(result.category).toBe('roster');
    });
  });

  describe('handleDirect — greeting', () => {
    it('responds to hello', () => {
      const result = handler.handleDirect('hello', makeContext());
      expect(result.category).toBe('greeting');
      expect(result.response).toContain('coordinator');
    });

    it('responds to hi', () => {
      const result = handler.handleDirect('hi', makeContext());
      expect(result.category).toBe('greeting');
    });

    it('responds to "hey"', () => {
      const result = handler.handleDirect('hey there', makeContext());
      expect(result.category).toBe('greeting');
    });

    it('responds to "good morning"', () => {
      const result = handler.handleDirect('good morning', makeContext());
      expect(result.category).toBe('greeting');
    });
  });

  describe('handleDirect — unmatched', () => {
    it('returns fallback for unmatched message', () => {
      // Force through by calling handleDirect directly (even though shouldHandleDirectly would be false)
      const result = handler.handleDirect('xyxabc random gibberish', makeContext());
      expect(result.confidence).toBe('medium');
    });
  });

  // --- Event emission ---

  describe('event emission', () => {
    it('emits coordinator:routing event on direct handle', () => {
      const eventBus = new EventBus();
      const events: any[] = [];
      eventBus.subscribe('coordinator:routing', (e) => events.push(e));

      const ctx = makeContext({ eventBus });
      handler.handleDirect('status', ctx);

      expect(events.length).toBe(1);
      expect(events[0].payload.decision).toBe('direct');
      expect(events[0].payload.category).toBe('status');
    });

    it('does not emit when no event bus', () => {
      // No eventBus in context — should not throw
      const result = handler.handleDirect('status', makeContext({ eventBus: undefined }));
      expect(result.category).toBe('status');
    });
  });

  // --- Custom patterns ---

  describe('addPattern', () => {
    it('adds a custom pattern at runtime', () => {
      handler.addPattern({
        category: 'status',
        patterns: [/^ping$/i],
        handler: () => 'pong',
      });

      expect(handler.shouldHandleDirectly('ping')).toBe(true);
      const result = handler.handleDirect('ping', makeContext());
      expect(result.response).toBe('pong');
    });
  });

  describe('getPatterns', () => {
    it('returns all registered patterns', () => {
      const patterns = handler.getPatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  // --- Constructor with custom patterns ---

  describe('custom patterns via constructor', () => {
    it('uses only provided patterns', () => {
      const custom: DirectResponsePattern[] = [
        {
          category: 'help',
          patterns: [/^custom$/i],
          handler: () => 'custom-response',
        },
      ];
      const customHandler = new DirectResponseHandler(custom);

      expect(customHandler.shouldHandleDirectly('custom')).toBe(true);
      expect(customHandler.shouldHandleDirectly('help')).toBe(false); // default not included
    });
  });

  // --- Config-aware matching ---

  describe('config-aware matching', () => {
    it('accepts SquadConfig in shouldHandleDirectly', () => {
      // Passing config should not break anything
      expect(handler.shouldHandleDirectly('help', DEFAULT_CONFIG)).toBe(true);
      expect(handler.shouldHandleDirectly('xyz random', DEFAULT_CONFIG)).toBe(false);
    });
  });
});
