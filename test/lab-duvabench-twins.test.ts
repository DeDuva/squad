/**
 * Semantic twins, and the two ways they could quietly ruin Study A.
 *
 * The study's whole claim rests on a twin being the *same tool* with a
 * different name. Two failure modes would void it without failing anything:
 *
 * 1. **The twin does something different.** Handlers are shared, so this can
 *    only enter through argument translation — which is why the property test
 *    below samples arguments and compares twin against original on real files
 *    rather than asserting the mapping looks right.
 * 2. **The names themselves are a treatment.** If twins were systematically
 *    longer, or unpronounceable, or occasionally real words, the arm would
 *    differ from its control by more than familiarity and the effect measured
 *    would not be the one named.
 *
 * The per-tool contract is generated from the twin rather than written out,
 * because the lesson it encodes came from `list_files`: it needed `safeDir`
 * where every other tool needed `safePath`, and nothing caught that until each
 * tool had its own test. A twin that silently broke one tool's arguments would
 * be the same bug wearing a new name.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultTools, type LabTool } from '../packages/squad-lab/src/tools/default.js';
import { harnessDigest } from '../packages/squad-lab/src/harness.js';
import {
  buildToolset,
  docsBundle,
  generateTwin,
  invertToolNames,
  type RenameMap,
} from '../packages/duva-bench/src/twins.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'duvabench-twin-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  writeFileSync(join(dir, 'src', 'thing.js'), 'export const x = 1;\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const byName = (tools: LabTool[]) => new Map(tools.map((t) => [t.name, t]));

/** Translate a call written against the original into the twin's vocabulary. */
function toTwinArgs(map: RenameMap, tool: string, args: Record<string, unknown>) {
  const params = map.params[tool] ?? {};
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [params[k] ?? k, v]));
}

// ─── Isomorphism ─────────────────────────────────────────────────────────

describe('a twin is the same tool', () => {
  /**
   * Sampled calls per tool, including the shapes that have broken before:
   * the bare root listing, an omitted optional argument, a missing file, and a
   * path that tries to leave the jail.
   */
  const SAMPLES: Record<string, Array<Record<string, unknown>>> = {
    list_files: [{}, { path: '.' }, { path: '' }, { path: 'src' }, { path: 'nope' }],
    read_file: [{ path: 'README.md' }, { path: 'src/thing.js' }, { path: 'missing.txt' }],
    write_file: [
      { path: 'out.txt', content: 'hello\n' },
      { path: 'src/new.js', content: 'export const y = 2;\n' },
    ],
    run_node_test: [{ path: 'nope.test.js' }],
  };

  it('produces identical results to the original for every sampled call', async () => {
    // Two workspaces, so a write through one tool cannot be observed by the
    // other and mistaken for agreement.
    const a = workspace();
    const b = workspace();
    try {
      const original = byName(defaultTools(a.dir));
      const { tools, renameMap } = generateTwin(defaultTools(b.dir), 'study-a');
      const twin = byName(tools);

      for (const [name, samples] of Object.entries(SAMPLES)) {
        const originalTool = original.get(name)!;
        const twinTool = twin.get(renameMap.tools[name]!)!;

        for (const args of samples) {
          const fromOriginal = await originalTool.handler(args);
          const fromTwin = await twinTool.handler(toTwinArgs(renameMap, name, args));
          expect(fromTwin, `${name} ${JSON.stringify(args)}`).toEqual(fromOriginal);
        }
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('writes the same bytes through the twin as through the original', async () => {
    // Equal return values are not equal effects. This is the effect.
    const a = workspace();
    const b = workspace();
    try {
      const original = byName(defaultTools(a.dir));
      const { tools, renameMap } = generateTwin(defaultTools(b.dir), 'study-a');
      const twin = byName(tools);

      const args = { path: 'src/written.js', content: 'export const z = 3;\n' };
      await original.get('write_file')!.handler(args);
      await twin.get(renameMap.tools.write_file!)!.handler(toTwinArgs(renameMap, 'write_file', args));

      expect(readFileSync(join(b.dir, 'src/written.js'), 'utf8')).toBe(
        readFileSync(join(a.dir, 'src/written.js'), 'utf8'),
      );
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('passes an unmapped argument through rather than dropping it', async () => {
    // A model inventing a parameter should meet the original tool's own
    // reaction to it. Dropping it would make the twin more forgiving than the
    // tool it stands in for.
    const w = workspace();
    try {
      const { tools, renameMap } = generateTwin(defaultTools(w.dir), 'seed');
      const twinRead = byName(tools).get(renameMap.tools.read_file!)!;
      const args = toTwinArgs(renameMap, 'read_file', { path: 'README.md' });
      const result = await twinRead.handler({ ...args, invented: true });
      expect(result.resultType).toBe('success');
    } finally {
      w.cleanup();
    }
  });
});

// ─── The generated per-tool contract ─────────────────────────────────────

describe('every generated twin tool passes its own contract', () => {
  const w = workspace();
  const originals = defaultTools(w.dir);
  const { tools, renameMap } = generateTwin(defaultTools(w.dir), 'contract');
  const twin = byName(tools);

  // One case per tool, generated from the twin rather than hand-written — the
  // `list_files`/`safeDir` lesson: a tool without its own test is a tool whose
  // argument handling nobody checked.
  it.each(originals.map((t) => [t.name] as const))('%s', async (name) => {
    const twinName = renameMap.tools[name]!;
    const twinTool = twin.get(twinName);

    expect(twinTool, `no twin emitted for ${name}`).toBeDefined();

    // The signature is renamed, complete, and carries no leftover documentation.
    const originalParams = Object.keys(
      (originals.find((t) => t.name === name)!.parameters.properties as object) ?? {},
    );
    const twinParams = Object.keys((twinTool!.parameters.properties as object) ?? {});
    expect(twinParams).toHaveLength(originalParams.length);
    for (const param of originalParams) {
      expect(twinParams).toContain(renameMap.params[name]![param]);
    }
    for (const value of Object.values((twinTool!.parameters.properties as Record<string, unknown>) ?? {})) {
      expect(value).not.toHaveProperty('description');
    }

    // `required` moves with the rename, or the model is told to supply a
    // parameter the tool does not have.
    const originalRequired =
      (originals.find((t) => t.name === name)!.parameters.required as string[] | undefined) ?? [];
    const twinRequired = (twinTool!.parameters.required as string[] | undefined) ?? [];
    expect(twinRequired).toEqual(originalRequired.map((p) => renameMap.params[name]![p]));

    // And it runs: a valid call reaches the real handler and comes back with a
    // result shape, rather than throwing on an argument it failed to translate.
    const sample: Record<string, unknown> =
      name === 'write_file'
        ? { path: `probe-${name}.txt`, content: 'x' }
        : name === 'list_files'
          ? {}
          : { path: 'README.md' };
    const result = await twinTool!.handler(toTwinArgs(renameMap, name, sample));
    expect(typeof result.textResultForLlm).toBe('string');
    expect(['success', 'failure']).toContain(result.resultType);
  });

  it('cleans up', () => {
    w.cleanup();
    expect(true).toBe(true);
  });
});

// ─── The names ───────────────────────────────────────────────────────────

describe('twin names', () => {
  const w = workspace();
  const originals = defaultTools(w.dir);
  const { tools, renameMap } = generateTwin(originals, 'names');
  w.cleanup();

  it('is deterministic in the seed, and different across seeds', () => {
    // A twin that differed between planning and execution would split one cell
    // of a study into two studies.
    const again = generateTwin(defaultTools('/tmp/x'), 'names');
    expect(again.renameMap.tools).toEqual(renameMap.tools);
    expect(again.renameMap.params).toEqual(renameMap.params);

    const other = generateTwin(defaultTools('/tmp/x'), 'names-2');
    expect(other.renameMap.tools).not.toEqual(renameMap.tools);
  });

  it('matches length exactly, underscore structure included', () => {
    // Stated tolerance: zero. Every segment of an identifier is at least two
    // characters, and every integer >= 2 is a sum of 2s and 3s, so exact
    // matching is achievable rather than approximate.
    for (const [original, twin] of Object.entries(renameMap.tools)) {
      expect(twin.length, `${original} -> ${twin}`).toBe(original.length);
      expect(twin.split('_').map((s) => s.length)).toEqual(original.split('_').map((s) => s.length));
    }
    for (const [tool, params] of Object.entries(renameMap.params)) {
      for (const [original, twin] of Object.entries(params)) {
        expect(twin.length, `${tool}.${original} -> ${twin}`).toBe(original.length);
      }
    }
  });

  it('is pronounceable: strict alternation of consonant and vowel runs', () => {
    // Unpronounceable strings are a motor-skill treatment, not a familiarity
    // one — harder to copy accurately, which would show up as tool errors.
    for (const twin of Object.values(renameMap.tools)) {
      for (const segment of twin.split('_')) {
        expect(segment, twin).toMatch(/^(?:[bdfgklmnprstvz][aeiou])+[bdfgklmnprstvz]?$/);
      }
    }
  });

  it('avoids common words and the vocabulary it is replacing', () => {
    const forbidden = new Set(['file', 'files', 'list', 'read', 'write', 'run', 'node', 'test', 'path', 'content']);
    const names = [
      ...Object.values(renameMap.tools),
      ...Object.values(renameMap.params).flatMap((p) => Object.values(p)),
    ];
    for (const name of names) {
      for (const segment of name.split('_')) expect(forbidden.has(segment)).toBe(false);
    }
  });

  it('never collides — distinct tools get distinct names', () => {
    const names = Object.values(renameMap.tools);
    expect(new Set(names).size).toBe(names.length);
    expect(tools.map((t) => t.name).sort()).toEqual([...names].sort());
  });

  it('round-trips through the rename map', () => {
    const back = invertToolNames(renameMap);
    for (const [original, twin] of Object.entries(renameMap.tools)) {
      expect(back[twin]).toBe(original);
    }
    // S5 computes the hallucinated-call rate by resolving recorded tool names
    // against this map, so an unresolvable twin name is an uncomputable metric.
    for (const tool of tools) expect(back[tool.name]).toBeDefined();
  });

  it('holds every property across many seeds, not just a lucky one', () => {
    for (let i = 0; i < 200; i += 1) {
      const { renameMap: map } = generateTwin(defaultTools('/tmp/x'), `seed-${i}`);
      for (const [original, twin] of Object.entries(map.tools)) {
        expect(twin.length, `seed-${i}: ${original} -> ${twin}`).toBe(original.length);
        for (const segment of twin.split('_')) {
          expect(segment, `seed-${i}: ${twin}`).toMatch(/^(?:[bdfgklmnprstvz][aeiou])+[bdfgklmnprstvz]?$/);
        }
      }
      expect(new Set(Object.values(map.tools)).size).toBe(Object.keys(map.tools).length);
    }
  });
});

// ─── Doc bundles ─────────────────────────────────────────────────────────

describe('doc bundles', () => {
  const w = workspace();
  const originals = defaultTools(w.dir);
  w.cleanup();

  it('gives grade none literally nothing', () => {
    // The control condition. A description leaking through any other channel
    // would make `none` a weaker treatment than it claims to be.
    const bundle = docsBundle(originals, 'none');
    expect(bundle.text).toBe('');
  });

  it('names every tool at reference, and adds examples at rich', () => {
    const reference = docsBundle(originals, 'reference');
    const rich = docsBundle(originals, 'rich');

    for (const tool of originals) {
      expect(reference.text).toContain(tool.name);
      expect(rich.text).toContain(tool.name);
    }
    expect(reference.text).not.toContain('Worked examples');
    expect(rich.text).toContain('Worked examples');
    expect(rich.text.length).toBeGreaterThan(reference.text.length);
  });

  it('describes twins under their twin names, never leaking the original', () => {
    const { tools, renameMap } = generateTwin(originals, 'docs');
    const rich = docsBundle(tools, 'rich', renameMap);

    for (const [original, twin] of Object.entries(renameMap.tools)) {
      expect(rich.text).toContain(twin);
      // The point of the twin is that the model has never seen this tool. A
      // doc bundle that mentioned `write_file` would hand the familiarity back.
      expect(rich.text).not.toContain(original);
    }
    // Parameters too — an example calling {"path": …} would name the original.
    for (const params of Object.values(renameMap.params)) {
      for (const [original, twin] of Object.entries(params)) {
        if (rich.text.includes(`"${twin}"`)) expect(rich.text).not.toContain(`"${original}"`);
      }
    }
  });

  it('gives each grade its own digest', () => {
    const digests = (['none', 'reference', 'rich'] as const).map((g) => docsBundle(originals, g).digest);
    expect(new Set(digests).size).toBe(3);
  });
});

// ─── The harness digest ──────────────────────────────────────────────────

describe('docs fold into the harness digest', () => {
  const base = {
    toolSurface: 'registered' as const,
    systemPrompt: 'charter-only' as const,
    agents: [{ name: 'solver', role: 'Agent', prompt: 'Solve it.' }],
    routing: [],
    tools: ['read_file', 'write_file'],
    limits: { turnTimeoutMs: 1, deadlineMs: 2, graceMs: 3 },
    maxToolRounds: 120,
    harnessImpl: 'ai-sdk' as const,
    sdkVersion: '0.12.0',
  };

  it('leaves digests computed before the field existed unchanged', () => {
    // `canonicalJson` drops undefined, so an absent docs digest is absent from
    // the canonical form — every previously recorded harness digest still holds.
    expect(harnessDigest({ ...base, toolDocsDigest: undefined })).toBe(harnessDigest(base));
  });

  it('separates two arms that differ only in how much they were told', () => {
    // The central contrast of Study A. Without this the twin+none and twin+rich
    // arms would share a harness digest and read as one cell.
    const w = workspace();
    const tools = defaultTools(w.dir);
    w.cleanup();

    const none = docsBundle(tools, 'none').digest;
    const rich = docsBundle(tools, 'rich').digest;
    expect(harnessDigest({ ...base, toolDocsDigest: none })).not.toBe(
      harnessDigest({ ...base, toolDocsDigest: rich }),
    );
  });
});

// ─── Assembly ────────────────────────────────────────────────────────────

describe('buildToolset', () => {
  it('returns the standard toolset untwinned when no seed is given', () => {
    const w = workspace();
    try {
      const built = buildToolset(defaultTools(w.dir), { docsGrade: 'reference' });
      expect(built.renameMap).toBeUndefined();
      expect(built.tools.map((t) => t.name)).toEqual(defaultTools(w.dir).map((t) => t.name));
      expect(built.docs.grade).toBe('reference');
    } finally {
      w.cleanup();
    }
  });

  it('twins and documents together, so the docs match the names in play', () => {
    const w = workspace();
    try {
      const built = buildToolset(defaultTools(w.dir), { twinSeed: 'a', docsGrade: 'rich' });
      expect(built.renameMap).toBeDefined();
      for (const tool of built.tools) expect(built.docs.text).toContain(tool.name);
    } finally {
      w.cleanup();
    }
  });
});
