/**
 * Making tool counts mean the same thing on both sides of a comparison.
 *
 * Two problems, both observed in a live two-vendor run rather than predicted.
 *
 * The names do not join. The Anthropic backend reaches squad's registered tools
 * through an MCP bridge, so they arrive as `mcp__squad__write_file`; the Gemini
 * backend calls the same tool `write_file`. Grouping by raw name puts one
 * vendor's use of a tool in a different bucket from the other's.
 *
 * And the totals are not like-for-like. The Anthropic backend ships its own
 * Read/Write/Edit/Bash alongside whatever we register; Gemini has only what we
 * register. A run that used eight tools on each side looked like a tie and was
 * not — one side was two registered calls and six built-ins, the other was
 * eight registered. A single number cannot carry that, so the headline counts
 * registered calls and the built-ins are reported beside it rather than folded
 * in.
 */

/**
 * The prefix squad's tools acquire when bridged into the Claude Agent SDK.
 * Stripping it is what lets `write_file` on one vendor and
 * `mcp__squad__write_file` on the other be recognised as the same tool.
 */
export const MCP_BRIDGE_PREFIX = 'mcp__squad__';

export function normalizeToolName(name: string): string {
  return name.startsWith(MCP_BRIDGE_PREFIX) ? name.slice(MCP_BRIDGE_PREFIX.length) : name;
}

export interface ToolStat {
  name: string;
  count: number;
  failures: number;
}

export interface ToolBreakdown {
  /** Tools the lab registered — the like-for-like set. */
  registered: ToolStat[];
  /** Tools the backend brought with it, which differ by vendor. */
  builtin: ToolStat[];
  registeredCalls: number;
  registeredFailures: number;
  builtinCalls: number;
  builtinFailures: number;
  /**
   * True when the backend contributed tools of its own, i.e. when the total
   * call count is not comparable across vendors.
   */
  hasBuiltins: boolean;
}

/**
 * Split a run's tool stats into what we registered and what the backend added.
 *
 * Classification is by membership in the registered set rather than by the
 * shape of the name: the bridge prefix says how a tool was reached, not who
 * supplied it, and a backend is free to expose something that happens to look
 * bridged.
 */
export function classifyTools(tools: ToolStat[], registered: readonly string[]): ToolBreakdown {
  const known = new Set(registered.map(normalizeToolName));
  const merged = new Map<string, ToolStat & { registered: boolean }>();

  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    const isRegistered = known.has(name);
    // Merge on the normalized name so a vendor that reports a tool under both
    // forms — or two bridge routes to one tool — counts once.
    const key = `${isRegistered ? 'r' : 'b'}:${name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += tool.count;
      existing.failures += tool.failures;
    } else {
      merged.set(key, { name, count: tool.count, failures: tool.failures, registered: isRegistered });
    }
  }

  const all = [...merged.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const registeredTools = all.filter((t) => t.registered).map(strip);
  const builtinTools = all.filter((t) => !t.registered).map(strip);
  const sum = (xs: ToolStat[], k: 'count' | 'failures') => xs.reduce((n, x) => n + x[k], 0);

  return {
    registered: registeredTools,
    builtin: builtinTools,
    registeredCalls: sum(registeredTools, 'count'),
    registeredFailures: sum(registeredTools, 'failures'),
    builtinCalls: sum(builtinTools, 'count'),
    builtinFailures: sum(builtinTools, 'failures'),
    hasBuiltins: builtinTools.length > 0,
  };
}

function strip(t: ToolStat & { registered: boolean }): ToolStat {
  return { name: t.name, count: t.count, failures: t.failures };
}
