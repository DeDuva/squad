/**
 * What "the same harness" has to mean for a comparison to survive.
 *
 * The M7 slice compared three models and could not have said anything about
 * them: the Anthropic backend brought six tools of its own and the Gemini
 * backend brought none, so one vendor's agents ran a different program. The
 * digest exists so that stops being invisible — two runs are comparable only if
 * it matches, and it must therefore move for every difference that matters and
 * stay still for every one that does not.
 *
 * The second property is the one worth testing hardest. A digest that also
 * moved with the *model* would make every cell its own harness, and the whole
 * experiment — vary the model, hold everything else — could never be expressed.
 */

import { describe, it, expect } from 'vitest';
import {
  harnessDigest,
  harnessLabels,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_SURFACE,
  type HarnessSpec,
} from '../packages/squad-lab/src/harness.js';

const BASE: HarnessSpec = {
  toolSurface: 'registered',
  systemPrompt: 'charter-only',
  agents: [
    { name: 'Backend', role: 'Implementation', prompt: 'implement it' },
    { name: 'Tester', role: 'Verification', prompt: 'test it' },
  ],
  routing: [{ workType: 'implement', agents: ['Backend', 'Tester'], confidence: 'high', examples: ['a'] }],
  tools: ['write_file', 'read_file', 'run_node_test'],
  limits: { turnTimeoutMs: 300_000, deadlineMs: 900_000, graceMs: 15_000 },
  sdkVersion: '0.11.0',
};

const withChange = (patch: Partial<HarnessSpec>): HarnessSpec => ({ ...BASE, ...patch });

describe('the harness digest moves when the harness does', () => {
  it.each([
    ['the tool surface', { toolSurface: 'native' as const }],
    ['the system prompt mode', { systemPrompt: 'backend-preset' as const }],
    ["a charter's text", { agents: [{ name: 'Backend', role: 'Implementation', prompt: 'implement it differently' }, BASE.agents[1]!] }],
    ["an agent's name", { agents: [{ name: 'Backend2', role: 'Implementation', prompt: 'implement it' }, BASE.agents[1]!] }],
    ['the set of agents', { agents: [BASE.agents[0]!] }],
    ['the registered tools', { tools: ['write_file', 'read_file'] }],
    ['a limit', { limits: { ...BASE.limits, deadlineMs: 600_000 } }],
    ['the SDK version', { sdkVersion: '0.12.0' }],
    ['a routing rule', { routing: [{ workType: 'implement', agents: ['Backend'], confidence: 'high', examples: ['a'] }] }],
  ])('changes with %s', (_label, patch) => {
    expect(harnessDigest(withChange(patch))).not.toBe(harnessDigest(BASE));
  });
});

describe('and stays still when it does not', () => {
  it('does not depend on the order agents, tools or routing were listed in', () => {
    const reordered = withChange({
      agents: [BASE.agents[1]!, BASE.agents[0]!],
      tools: ['run_node_test', 'write_file', 'read_file'],
      routing: [{ ...BASE.routing[0]!, agents: ['Tester', 'Backend'] }],
    });
    expect(harnessDigest(reordered)).toBe(harnessDigest(BASE));
  });

  it('does not depend on the model, which is the whole point', () => {
    // The digest names how the agents are driven, never who is driving. If the
    // model were in it, "hold the harness constant and vary the model" would be
    // a sentence with no expressible meaning.
    expect(harnessDigest(BASE)).toBe(harnessDigest({ ...BASE }));
    expect(Object.keys(harnessLabels(BASE))).not.toContain('model');
  });

  it('ignores routing examples, which are prompt colour rather than behaviour', () => {
    const reworded = withChange({
      routing: [{ ...BASE.routing[0]!, examples: ['something else entirely'] }],
    });
    expect(harnessDigest(reworded)).toBe(harnessDigest(BASE));
  });
});

describe('the labels a run carries', () => {
  it('name the surface and the prompt mode in plain text beside the digest', () => {
    // The digest proves sameness; these two say what the sameness *was*, so a
    // reader does not have to hold a lookup table to interpret a row.
    const labels = harnessLabels(BASE);
    expect(labels['tool_surface']).toBe('registered');
    expect(labels['system_prompt']).toBe('charter-only');
    expect(labels['harness']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to the comparable configuration', () => {
    // Parity is the default because comparison is what the lab is for. A lab
    // that defaulted to the richer, incomparable surface would produce numbers
    // that look like a comparison and are not — which is what M7 did.
    expect(DEFAULT_TOOL_SURFACE).toBe('registered');
    expect(DEFAULT_SYSTEM_PROMPT).toBe('charter-only');
  });
});
