/**
 * Whether two harnesses tell ADP the same kind of story.
 *
 * This started as a clause and could not be one. Every absolute list we tried
 * was wrong in a way that made the contract lie: asserting `session:created`
 * failed both real backends, because fan-out emits it around whatever session
 * factory it was handed and no harness owns it; asserting `session:message`
 * failed both as well, because *neither* arm emits it and the recorder's
 * `kind: 'message'` case has no producer.
 *
 * What is left is comparative, and it is the property that actually matters: a
 * run whose harness reported one fewer kind of event looks quieter than it was,
 * and the quiet gets attributed to the model.
 */

import { describe, it, expect } from 'vitest';

import {
  compareTelemetry,
  formatTelemetryDiff,
  type ConformanceReport,
} from '../packages/squad-lab/src/conformance.ts';

const report = (harness: string, emitted: string[]): ConformanceReport => ({
  harness,
  passed: emitted.length,
  failed: 0,
  clauses: [],
  emitted: [...emitted].sort(),
});

// What a real native run actually put on the bus, taken from a recorded
// `bus.jsonl`: no `session:message` anywhere, and the lifecycle pair present
// because fan-out supplies it rather than the harness.
const NATIVE = ['coordinator:routing', 'session:created', 'session:destroyed', 'session:model_usage', 'session:tool_call'];

describe('compareTelemetry', () => {
  it('passes two arms that emit the same vocabulary', () => {
    const diff = compareTelemetry(report('squad-native', NATIVE), report('ai-sdk', NATIVE));
    expect(diff.ok).toBe(true);
    expect(diff.identical).toBe(true);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(diff.shared).toEqual([...NATIVE].sort());
  });

  it('fails an arm that omits a required type', () => {
    const quiet = NATIVE.filter((t) => t !== 'session:tool_call');
    const diff = compareTelemetry(report('squad-native', NATIVE), report('ai-sdk', quiet));
    expect(diff.ok).toBe(false);
    expect(diff.missingRequired).toEqual([{ harness: 'ai-sdk', types: ['session:tool_call'] }]);
    expect(diff.onlyInA).toEqual(['session:tool_call']);
  });

  it('fails whichever side is the quiet one', () => {
    const quiet = NATIVE.filter((t) => t !== 'session:model_usage');
    const diff = compareTelemetry(report('squad-native', quiet), report('ai-sdk', NATIVE));
    expect(diff.ok).toBe(false);
    expect(diff.missingRequired).toEqual([
      { harness: 'squad-native', types: ['session:model_usage'] },
    ]);
  });

  it('does not fail on a conditional event only one arm happened to reach', () => {
    // The real case this softening exists for: `agent:milestone` fires only if
    // a run exhausts its budget or gets aborted, and a model that finishes
    // early never does. Gemini's native backend stopped after one round while
    // the neutral loop ran to its ceiling — a fact about the models, reported
    // rather than gated.
    const diff = compareTelemetry(
      report('squad-native:gemini', NATIVE),
      report('ai-sdk:gemini', [...NATIVE, 'agent:milestone']),
    );
    expect(diff.ok).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.onlyInB).toEqual(['agent:milestone']);
  });

  it('reports a conditional difference without calling it a failure', () => {
    const text = formatTelemetryDiff(
      'squad-native',
      'ai-sdk',
      compareTelemetry(report('a', NATIVE), report('b', [...NATIVE, 'agent:milestone'])),
    );
    expect(text).toContain('differs only in conditional events');
    expect(text).not.toContain('FAIL');
  });

  it('says why it matters when a required type is missing', () => {
    const bad = formatTelemetryDiff(
      'squad-native',
      'ai-sdk',
      compareTelemetry(report('a', NATIVE), report('b', [])),
    );
    expect(bad).toContain('FAIL');
    expect(bad).toContain('never emitted: session:model_usage, session:tool_call');
    expect(bad).toContain('read as a property of the model');
  });
});
