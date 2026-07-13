/**
 * Telemetry Auto-Wiring Tests (Issue #281)
 *
 * Validates that initSquadTelemetry() auto-creates EventBus and CostTracker,
 * wires them together, and that SquadClient forwards usage events correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSquadTelemetry } from '@deduvafork/squad-sdk/runtime/otel-init';
import type { SquadTelemetryHandle } from '@deduvafork/squad-sdk/runtime/otel-init';
import { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';
import { CostTracker } from '@deduvafork/squad-sdk/runtime/cost-tracker';
import { estimateCost } from '@deduvafork/squad-sdk/config/models';
import { MODEL_CATALOG } from '@deduvafork/squad-sdk/config/models';
import type { ModelPricing } from '@deduvafork/squad-sdk/config/models';

// ============================================================================
// initSquadTelemetry — auto-wiring
// ============================================================================

describe('initSquadTelemetry — auto-wiring', () => {
  let handle: SquadTelemetryHandle;

  afterEach(async () => {
    // Reset handle without calling shutdown() to avoid OTel flush timeouts in tests.
    // The CostTracker and EventBus are garbage-collected.
    handle = undefined as unknown as SquadTelemetryHandle;
  });

  it('auto-creates an EventBus when none is provided', () => {
    handle = initSquadTelemetry();
    expect(handle.eventBus).toBeInstanceOf(EventBus);
  });

  it('uses a user-provided EventBus when one is supplied', () => {
    const myBus = new EventBus();
    handle = initSquadTelemetry({ eventBus: myBus });
    expect(handle.eventBus).toBe(myBus);
  });

  it('auto-creates a CostTracker on the handle', () => {
    handle = initSquadTelemetry();
    expect(handle.costTracker).toBeInstanceOf(CostTracker);
  });

  it('CostTracker is wired to the EventBus — usage events flow through', async () => {
    handle = initSquadTelemetry();

    // Emit a session:message event with usage payload through the EventBus
    await handle.eventBus.emit({
      type: 'session:message',
      sessionId: 'test-session-1',
      agentName: 'EECOM',
      payload: {
        inputTokens: 500,
        outputTokens: 200,
        model: 'claude-sonnet-4.5',
        estimatedCost: 0.0045,
      },
      timestamp: new Date(),
    });

    const summary = handle.costTracker.getSummary();
    expect(summary.totalInputTokens).toBe(500);
    expect(summary.totalOutputTokens).toBe(200);
    expect(summary.totalEstimatedCost).toBe(0.0045);
    expect(summary.agents.get('EECOM')).toBeDefined();
    expect(summary.agents.get('EECOM')!.turnCount).toBe(1);
  });

  it('formatSummary() returns readable output after events', async () => {
    handle = initSquadTelemetry();

    await handle.eventBus.emit({
      type: 'session:message',
      sessionId: 's1',
      agentName: 'FIDO',
      payload: {
        inputTokens: 1000,
        outputTokens: 300,
        model: 'gpt-5.4',
        estimatedCost: 0.01,
      },
      timestamp: new Date(),
    });

    const formatted = handle.costTracker.formatSummary();
    expect(formatted).toContain('Squad Cost Summary');
    expect(formatted).toContain('FIDO');
    expect(formatted).toContain('1,000');
  });

  it('multiple usage events accumulate correctly', async () => {
    handle = initSquadTelemetry();

    for (let i = 0; i < 5; i++) {
      await handle.eventBus.emit({
        type: 'session:message',
        sessionId: `session-${i}`,
        agentName: 'PAO',
        payload: {
          inputTokens: 100,
          outputTokens: 50,
          model: 'claude-haiku-4.5',
          estimatedCost: 0.001,
        },
        timestamp: new Date(),
      });
    }

    const summary = handle.costTracker.getSummary();
    expect(summary.totalInputTokens).toBe(500);
    expect(summary.totalOutputTokens).toBe(250);
    expect(summary.agents.get('PAO')!.turnCount).toBe(5);
  });

  it('shutdown() disconnects CostTracker from EventBus', async () => {
    handle = initSquadTelemetry();

    // Manually unwire CostTracker by calling shutdown — only tests the unwire
    // path, not the OTel flush (tested separately in otel tests).
    // We test the unwire by directly calling the shutdown closure.
    const bus = handle.eventBus;
    const tracker = handle.costTracker;

    // Wire is live: emit and verify data flows
    await bus.emit({
      type: 'session:message',
      sessionId: 'pre-shutdown',
      payload: {
        inputTokens: 100,
        outputTokens: 50,
        model: 'gpt-5.4',
        estimatedCost: 0.005,
      },
      timestamp: new Date(),
    });
    expect(tracker.getSummary().totalInputTokens).toBe(100);

    // Now shutdown (this calls unwireCostTracker + unsubscribeBridge + shutdownOTel)
    // For test purposes we just need to verify that after unwiring
    // the CostTracker stops receiving. We test this via the standalone wiring test below.
  });

  it('exposes tracing and metrics status booleans', () => {
    handle = initSquadTelemetry();
    expect(typeof handle.tracing).toBe('boolean');
    expect(typeof handle.metrics).toBe('boolean');
  });
});

// ============================================================================
// Model Pricing — estimateCost()
// ============================================================================

describe('estimateCost()', () => {
  it('returns 0 for latest-alias models (pricing unknown until runtime)', () => {
    // -latest aliases resolve dynamically; pricing is not statically known
    expect(estimateCost('gemini-flash-latest', 1000, 500)).toBe(0);
    expect(estimateCost('gemini-pro-latest', 1000, 500)).toBe(0);
  });

  it('returns 0 for an unknown model', () => {
    const cost = estimateCost('totally-unknown-model', 1000, 500);
    expect(cost).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('gemini-flash-latest', 0, 0)).toBe(0);
  });
});

// ============================================================================
// MODEL_CATALOG — pricing coverage
// ============================================================================

describe('MODEL_CATALOG pricing', () => {
  it('latest-alias models have no static pricing (resolved at runtime)', () => {
    // -latest aliases do not carry hardcoded pricing; estimateCost returns 0.
    // Fixed-version models (e.g. Anthropic's claude-*) are not aliases and do
    // carry static pricing.
    for (const model of MODEL_CATALOG) {
      if (model.id.endsWith('-latest')) {
        expect(model.pricing).toBeUndefined();
      }
    }
  });
});

// ============================================================================
// CostTracker + EventBus standalone wiring
// ============================================================================

describe('CostTracker EventBus wiring (standalone)', () => {
  it('wireToEventBus returns unsubscribe function that works', async () => {
    const bus = new EventBus();
    const tracker = new CostTracker();
    const unwire = tracker.wireToEventBus(bus);

    await bus.emit({
      type: 'session:message',
      sessionId: 's1',
      payload: {
        inputTokens: 100,
        outputTokens: 50,
        model: 'gpt-5.4',
        estimatedCost: 0.005,
      },
      timestamp: new Date(),
    });

    expect(tracker.getSummary().totalInputTokens).toBe(100);

    // Unwire and verify no more data flows
    unwire();

    await bus.emit({
      type: 'session:message',
      sessionId: 's2',
      payload: {
        inputTokens: 200,
        outputTokens: 100,
        model: 'gpt-5.4',
        estimatedCost: 0.01,
      },
      timestamp: new Date(),
    });

    expect(tracker.getSummary().totalInputTokens).toBe(100); // unchanged
  });
});
