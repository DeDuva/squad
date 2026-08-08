/**
 * Semantic twins: the same toolset, wearing names the model has never seen.
 *
 * This is Study A's instrument. The hypothesis is that agents do better with
 * in-distribution tools than with equally-capable unfamiliar ones, and the only
 * way to test that without confounding it with capability is to hold capability
 * *exactly* fixed and change nothing but the vocabulary. A twin therefore does
 * not reimplement anything: it renames the tool and its parameters, translates
 * arguments back, and calls the original handler. Isomorphism is by
 * construction, which leaves the argument-translation layer as the only thing
 * that can be wrong — and that is what the property test hunts.
 *
 * Three properties the names have to satisfy, each for a reason:
 *
 * - **Deterministic in the seed.** A twin that differed between the planning run
 *   and the executing run would silently make two cells of one study into two
 *   studies. Same seed, same toolset, same names, forever.
 * - **Length- and structure-matched.** `list_files` becomes something of exactly
 *   ten characters with the underscore in the same place, because a twin that
 *   was systematically longer would vary token count alongside familiarity, and
 *   one rendered as a single token would read as one concept where the original
 *   read as two.
 * - **Pronounceable but not words.** Unpronounceable strings are their own
 *   treatment — they are harder to copy accurately, which is a motor-skill
 *   confound rather than a familiarity one. Real words reintroduce the very
 *   familiarity being removed. So names are built from consonant-vowel
 *   syllables and re-rolled if they land on anything in `COMMON_WORDS`.
 *
 * What is *not* claimed: these names are not proven absent from English. They
 * are proven absent from an embedded list of common words and from the original
 * toolset's own vocabulary, which is a smaller claim, stated here rather than
 * implied by the word "non-dictionary".
 *
 * Documentation is a separate channel. A twin's own `description` is stripped to
 * nothing informative, so the *only* thing that varies documentation is the
 * grade of the bundle injected into the charter. That is what makes "docs
 * compensate for unfamiliarity" a measurable claim rather than two changes at
 * once.
 */

import { createHash } from 'node:crypto';

import type { LabTool } from '@deduvafork/squad-lab/tools/default';

import type { DocsGrade } from './study.js';

// ─── Deterministic randomness ────────────────────────────────────────────

/**
 * A tiny seeded generator. Not cryptographic — it only has to be reproducible.
 *
 * Seeded from a sha256 of the caller's seed so that unrelated seeds ("a", "b")
 * do not produce adjacent streams.
 */
function rng(seed: string): () => number {
  const hash = createHash('sha256').update(seed, 'utf8').digest();
  let state = hash.readUInt32BE(0) || 0x9e3779b9;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const CONSONANTS = 'bdfgklmnprstvz'.split('');
const VOWELS = 'aeiou'.split('');

/**
 * Common English words a generated name must not collide with.
 *
 * Deliberately weighted towards the vocabulary a toolset draws on — a twin that
 * happened to be called `file` would be the one collision that matters.
 */
const COMMON_WORDS = new Set([
  'about', 'after', 'again', 'also', 'back', 'base', 'been', 'before', 'best', 'both',
  'call', 'came', 'case', 'code', 'come', 'copy', 'data', 'date', 'delete', 'dir',
  'does', 'done', 'down', 'each', 'edit', 'else', 'even', 'ever', 'file', 'files',
  'find', 'first', 'form', 'from', 'full', 'get', 'give', 'good', 'grep', 'hand',
  'have', 'head', 'help', 'here', 'high', 'home', 'into', 'item', 'just', 'keep',
  'kind', 'know', 'last', 'left', 'less', 'life', 'like', 'line', 'link', 'list',
  'load', 'long', 'look', 'made', 'make', 'many', 'mode', 'more', 'most', 'move',
  'much', 'must', 'name', 'need', 'next', 'node', 'note', 'only', 'open', 'over',
  'page', 'part', 'pass', 'past', 'path', 'plan', 'read', 'real', 'root', 'rest',
  'right', 'run', 'said', 'same', 'save', 'seem', 'send', 'set', 'show', 'side',
  'site', 'size', 'some', 'sort', 'stop', 'such', 'sure', 'take', 'tell', 'test',
  'text', 'than', 'that', 'them', 'then', 'they', 'this', 'time', 'tool', 'type',
  'used', 'user', 'very', 'view', 'want', 'well', 'were', 'what', 'when', 'will',
  'wire', 'with', 'word', 'work', 'write', 'year', 'your', 'zone',
  'be', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on',
  'or', 'so', 'to', 'up', 'us', 'we', 'an', 'as', 'at', 'by',
]);

/**
 * Decompose a length into syllables of 2 and 3 characters.
 *
 * Every integer ≥ 2 is expressible as 2a + 3b, which is why exact length
 * matching is achievable rather than approximate for any realistic identifier.
 */
function syllableLengths(target: number): number[] {
  if (target < 2) return [2];
  const threes = target % 2 === 0 ? 0 : 1;
  const twos = (target - threes * 3) / 2;
  return [...Array<number>(twos).fill(2), ...Array<number>(threes).fill(3)];
}

/** One pronounceable token of exactly `length` characters (minimum 2). */
function token(length: number, next: () => number): string {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  return syllableLengths(length)
    .map((size) =>
      size === 2
        ? `${pick(CONSONANTS)}${pick(VOWELS)}`
        : `${pick(CONSONANTS)}${pick(VOWELS)}${pick(CONSONANTS)}`,
    )
    .join('');
}

/**
 * Rename one identifier, preserving its `_`-separated shape.
 *
 * Re-rolls on a collision with a common word, with the original vocabulary, or
 * with a name already issued. Bounded so a pathological seed cannot hang; the
 * bound has never been reached in practice and raising it is cheaper than a
 * generator that can spin.
 */
function renameIdentifier(
  original: string,
  next: () => number,
  taken: Set<string>,
  reserved: Set<string>,
): string {
  const segments = original.split('_');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = segments.map((segment) => token(segment.length, next)).join('_');
    const parts = candidate.split('_');
    const collides =
      taken.has(candidate) ||
      reserved.has(candidate) ||
      parts.some((p) => COMMON_WORDS.has(p) || reserved.has(p));
    if (!collides) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`could not generate a twin name for '${original}' — seed exhausted`);
}

// ─── The rename map ──────────────────────────────────────────────────────

export interface RenameMap {
  seed: string;
  /** original tool name → twin tool name. */
  tools: Record<string, string>;
  /** original tool name → (original parameter → twin parameter). */
  params: Record<string, Record<string, string>>;
}

/**
 * twin tool name → original tool name.
 *
 * S5 needs this direction: the hallucinated-call rate is the share of tool calls
 * naming something outside the arm's toolset, and a trajectory recorded under
 * twin names has to be read back against the original surface to compute it.
 */
export function invertToolNames(map: RenameMap): Record<string, string> {
  return Object.fromEntries(Object.entries(map.tools).map(([original, twin]) => [twin, original]));
}

// ─── Schema rewriting ────────────────────────────────────────────────────

/** Rename `properties` keys and the `required` list of a JSON-schema object. */
function renameSchema(
  schema: Record<string, unknown>,
  params: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };

  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        params[key] ?? key,
        // Property descriptions are stripped: they are documentation, and
        // documentation is the treatment. Leaving them would let the `none`
        // grade quietly carry a reference.
        stripDescription(value),
      ]),
    );
  }

  const required = schema.required as string[] | undefined;
  if (Array.isArray(required)) out.required = required.map((key) => params[key] ?? key);

  return out;
}

function stripDescription(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const { description: _dropped, ...rest } = value as Record<string, unknown>;
  return rest;
}

// ─── Generation ──────────────────────────────────────────────────────────

export interface Twin {
  tools: LabTool[];
  renameMap: RenameMap;
}

/**
 * Build an isomorphic twin of a toolset.
 *
 * The twin's handler translates twin argument names back to the originals and
 * calls the original handler, so behaviour cannot drift. Arguments the map does
 * not know are passed through untouched rather than dropped: a model inventing
 * a parameter should see the original tool's own reaction to it, not a
 * silently-different one.
 */
export function generateTwin(tools: LabTool[], seed: string): Twin {
  const next = rng(seed);
  const takenTools = new Set<string>();
  const reserved = new Set<string>();
  for (const tool of tools) {
    reserved.add(tool.name);
    for (const segment of tool.name.split('_')) reserved.add(segment);
    for (const key of Object.keys((tool.parameters.properties as object) ?? {})) reserved.add(key);
  }

  const renameMap: RenameMap = { seed, tools: {}, params: {} };
  const twinTools: LabTool[] = [];

  for (const tool of tools) {
    const twinName = renameIdentifier(tool.name, next, takenTools, reserved);
    renameMap.tools[tool.name] = twinName;

    const takenParams = new Set<string>();
    const params: Record<string, string> = {};
    for (const key of Object.keys((tool.parameters.properties as object) ?? {})) {
      params[key] = renameIdentifier(key, next, takenParams, reserved);
    }
    renameMap.params[tool.name] = params;

    const toOriginal = Object.fromEntries(Object.entries(params).map(([from, to]) => [to, from]));
    const inner = tool.handler;

    twinTools.push({
      name: twinName,
      // Uninformative by design. Everything a model learns about this tool
      // beyond its signature comes from the charter's doc bundle, which is the
      // variable under test.
      description: twinName,
      parameters: renameSchema(tool.parameters, params),
      handler: async (args: Record<string, unknown>, ctx?: unknown) => {
        const translated: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args ?? {})) {
          translated[toOriginal[key] ?? key] = value;
        }
        return inner(translated, ctx);
      },
    });
  }

  return { tools: twinTools, renameMap };
}

// ─── Doc bundles ─────────────────────────────────────────────────────────

/** A worked example, written once per original tool and renamed with it. */
const WORKED_EXAMPLES: Record<string, (name: string, params: Record<string, string>) => string> = {
  list_files: (name, p) =>
    `Call ${name} with {"${p.path ?? 'path'}": "."} to see every file in the repository, then read the ones that matter.`,
  read_file: (name, p) => `Call ${name} with {"${p.path ?? 'path'}": "README.md"} to read a file.`,
  write_file: (name, p) =>
    `Call ${name} with {"${p.path ?? 'path'}": "src/thing.js", "${p.content ?? 'content'}": "export const x = 1;\\n"} to create or overwrite a file.`,
  run_node_test: (name, p) =>
    `Call ${name} with {"${p.path ?? 'path'}": "test/thing.test.js"} to run one test file and read its output.`,
};

/** What each original tool does, in one line, independent of its name. */
const REFERENCE: Record<string, string> = {
  list_files: 'Lists files in the repository recursively as repo-relative paths.',
  read_file: 'Reads a UTF-8 text file from the repository.',
  write_file: 'Writes a UTF-8 text file in the repository, creating or overwriting it.',
  run_node_test: "Runs one Node.js test file with the built-in runner and returns its output.",
};

export interface DocsBundle {
  grade: DocsGrade;
  /** Charter text. Empty at grade `none`. */
  text: string;
  /** Folded into `harnessDigest`, so two docs grades are two harnesses. */
  digest: string;
}

/**
 * Build the documentation the charter carries.
 *
 * `none` is genuinely nothing — an agent sees names and a JSON schema. That is
 * the condition the whole study is contrasted against, so it must not leak a
 * description through some other channel.
 */
export function docsBundle(
  tools: LabTool[],
  grade: DocsGrade,
  renameMap?: RenameMap,
): DocsBundle {
  const lines: string[] = [];

  if (grade !== 'none') {
    lines.push('Tools available to you:');
    for (const tool of tools) {
      const original = renameMap ? invertToolNames(renameMap)[tool.name] : tool.name;
      const summary = REFERENCE[original ?? tool.name];
      const parameters = Object.keys((tool.parameters.properties as object) ?? {});
      lines.push(`- ${tool.name}(${parameters.join(', ')})${summary ? ` — ${summary}` : ''}`);
    }
  }

  if (grade === 'rich') {
    lines.push('', 'Worked examples:');
    for (const tool of tools) {
      const original = renameMap ? invertToolNames(renameMap)[tool.name] : tool.name;
      const example = WORKED_EXAMPLES[original ?? tool.name];
      if (!example) continue;
      const params = renameMap?.params[original ?? tool.name] ?? {};
      lines.push(`- ${example(tool.name, params)}`);
    }
  }

  const text = lines.join('\n');
  return {
    grade,
    text,
    // The grade is part of the digest as well as the text: two bundles that
    // rendered identically because a toolset was empty are still two different
    // experimental conditions.
    digest: createHash('sha256').update(`${grade}\n${text}`, 'utf8').digest('hex'),
  };
}

// ─── Assembly ────────────────────────────────────────────────────────────

export interface BuiltToolset {
  tools: LabTool[];
  docs: DocsBundle;
  /** Absent when the standard toolset was used. */
  renameMap?: RenameMap;
}

/**
 * The toolset an arm actually runs: standard or twinned, with its docs.
 *
 * `twinSeed` absent means the standard toolset — which is Study A's control
 * arm, and the reason the twin is opt-in rather than the default.
 */
export function buildToolset(
  tools: LabTool[],
  options: { twinSeed?: string; docsGrade: DocsGrade },
): BuiltToolset {
  if (options.twinSeed === undefined) {
    return { tools, docs: docsBundle(tools, options.docsGrade) };
  }
  const twin = generateTwin(tools, options.twinSeed);
  return {
    tools: twin.tools,
    docs: docsBundle(twin.tools, options.docsGrade, twin.renameMap),
    renameMap: twin.renameMap,
  };
}
