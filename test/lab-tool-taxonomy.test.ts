/**
 * Tool counts that mean the same thing on both sides of a comparison.
 *
 * The fixtures here are the real `/runs/stats` tool lists from a live
 * two-vendor run on one goal. Both sides made eight tool calls, which read as a
 * tie and was not: one was two registered calls plus six the backend brought,
 * the other was eight registered.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTools,
  normalizeToolName,
  MCP_BRIDGE_PREFIX,
} from '../packages/squad-lab/src/tools/taxonomy.js';

const REGISTERED = ['write_file', 'read_file', 'run_node_test'];

// Verbatim from the anthropic run: squad's tools arrive MCP-bridged, alongside
// the backend's own Read/Write/Bash/ToolSearch.
const ANTHROPIC_TOOLS = [
  { name: 'Bash', count: 3, failures: 0 },
  { name: 'ToolSearch', count: 1, failures: 0 },
  { name: 'mcp__squad__run_node_test', count: 1, failures: 0 },
  { name: 'mcp__squad__write_file', count: 1, failures: 0 },
  { name: 'Write', count: 1, failures: 1 },
  { name: 'Read', count: 1, failures: 0 },
];

// Verbatim from the gemini run: only what we registered, under bare names.
const GEMINI_TOOLS = [
  { name: 'write_file', count: 4, failures: 0 },
  { name: 'run_node_test', count: 2, failures: 1 },
  { name: 'read_file', count: 2, failures: 2 },
];

describe('normalizeToolName', () => {
  it('strips the MCP bridge prefix so the same tool joins across vendors', () => {
    expect(normalizeToolName(`${MCP_BRIDGE_PREFIX}write_file`)).toBe('write_file');
    expect(normalizeToolName('write_file')).toBe('write_file');
  });

  it('leaves a backend tool alone', () => {
    expect(normalizeToolName('Bash')).toBe('Bash');
  });
});

describe('classifyTools', () => {
  it('separates what we registered from what the backend brought', () => {
    const a = classifyTools(ANTHROPIC_TOOLS, REGISTERED);
    expect(a.registered.map((t) => t.name).sort()).toEqual(['run_node_test', 'write_file']);
    expect(a.builtin.map((t) => t.name).sort()).toEqual(['Bash', 'Read', 'ToolSearch', 'Write']);
    expect(a.registeredCalls).toBe(2);
    expect(a.builtinCalls).toBe(6);
    expect(a.hasBuiltins).toBe(true);
  });

  it('reports a vendor with no built-ins as entirely registered', () => {
    const g = classifyTools(GEMINI_TOOLS, REGISTERED);
    expect(g.builtin).toEqual([]);
    expect(g.registeredCalls).toBe(8);
    expect(g.hasBuiltins).toBe(false);
  });

  it('exposes the disparity the raw total hides', () => {
    // Eight calls each. The comparable number is 2 against 8.
    const a = classifyTools(ANTHROPIC_TOOLS, REGISTERED);
    const g = classifyTools(GEMINI_TOOLS, REGISTERED);
    expect(a.registeredCalls + a.builtinCalls).toBe(g.registeredCalls + g.builtinCalls);
    expect(a.registeredCalls).not.toBe(g.registeredCalls);
  });

  it('carries failures with the half they belong to', () => {
    const a = classifyTools(ANTHROPIC_TOOLS, REGISTERED);
    // The one failure was the backend's own Write, not a registered tool.
    expect(a.registeredFailures).toBe(0);
    expect(a.builtinFailures).toBe(1);
  });

  it('merges a tool reported under both the bridged and bare name', () => {
    const merged = classifyTools(
      [
        { name: 'write_file', count: 2, failures: 0 },
        { name: `${MCP_BRIDGE_PREFIX}write_file`, count: 3, failures: 1 },
      ],
      REGISTERED,
    );
    expect(merged.registered).toEqual([{ name: 'write_file', count: 5, failures: 1 }]);
  });

  it('classifies by what was registered, not by the shape of the name', () => {
    // A backend is free to expose something that looks bridged; membership in
    // the registered set is the fact, the prefix is only how it was reached.
    const out = classifyTools([{ name: `${MCP_BRIDGE_PREFIX}something_else`, count: 1, failures: 0 }], REGISTERED);
    expect(out.registered).toEqual([]);
    expect(out.builtin.map((t) => t.name)).toEqual(['something_else']);
  });

  it('treats everything as built-in when nothing was registered', () => {
    const out = classifyTools(GEMINI_TOOLS, []);
    expect(out.registeredCalls).toBe(0);
    expect(out.builtinCalls).toBe(8);
  });

  it('handles a run that made no tool calls', () => {
    const out = classifyTools([], REGISTERED);
    expect(out).toMatchObject({ registeredCalls: 0, builtinCalls: 0, hasBuiltins: false });
  });

  it('orders each half by call count', () => {
    const a = classifyTools(ANTHROPIC_TOOLS, REGISTERED);
    expect(a.builtin[0]!.name).toBe('Bash');
  });
});
