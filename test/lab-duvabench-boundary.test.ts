/**
 * The import boundary around `packages/duva-bench`, enforced.
 *
 * duva-bench is written inside the squad fork but is meant to leave it: the
 * squad track and the Harbor track share tasks, graders, statistics and the ADP
 * record, and the only thing that makes extracting this package to a standalone
 * repo a mechanical job rather than an archaeology project is a short, explicit
 * list of what it is allowed to reach for. A convention would not survive six
 * milestones of an agent adding imports, so the list is a test.
 *
 * Three properties are worth stating, because each one is load-bearing and none
 * is obvious from the allowlist alone:
 *
 * 1. **Package barrels are not on the list — subpaths are.** `squad-lab`'s
 *    `src/index.ts` re-exports `runVariant`, and `run-variant.ts` is the single
 *    file in the lab that imports `SquadCoordinator`. Importing the lab's root
 *    barrel would therefore drag the coordinator into every duva-bench module
 *    at runtime while looking perfectly innocent in a diff. The same argument
 *    applies to `@deduvafork/squad-sdk`, whose root barrel exports everything.
 *
 * 2. **Relative imports may not leave the package.** Without this, the entire
 *    allowlist is one `../../squad-lab/src/run-variant.js` away from
 *    irrelevant.
 *
 * 3. **`src/arms/swarm.ts` is the one exemption.** The topology arm (S4) exists
 *    to run a real squad swarm, so it — and nothing else — may import
 *    `coordinator` and `client`. Encoding the exemption by path is what keeps
 *    "the coordinator lives in one file" a checkable claim.
 *
 * Source of truth: `packages/duva-bench/PLAN.md` §0.9 (the boundary) and §2
 * (the reuse map, which names the squad-lab modules).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, resolve, relative, dirname, sep } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const BENCH_ROOT = join(REPO_ROOT, 'packages', 'duva-bench');
const BENCH_SRC = join(BENCH_ROOT, 'src');
const LAB_ROOT = join(REPO_ROOT, 'packages', 'squad-lab');

// ─── The allowlist ───────────────────────────────────────────────────────

/**
 * squad-sdk subpaths every duva-bench file may import (PLAN §0.9).
 *
 * `runtime/event-payloads` is named in PLAN §2 as a module to reuse but was
 * omitted from §0.9's abbreviated list. It is type-only — it declares the
 * payload shapes carried by `runtime/event-bus`, which does not re-export them
 * — so honouring §2 costs no runtime coupling.
 *
 * `adp` covers §0.9's `adp/*`: the SDK's exports map publishes the ADP barrel
 * and no deeper path, and that barrel re-exports recorder, spool, client,
 * config and assignment — all of which PLAN §2 requires.
 */
const SDK_ALLOWED = [
  '@deduvafork/squad-sdk/runtime/event-bus',
  '@deduvafork/squad-sdk/runtime/event-payloads',
  '@deduvafork/squad-sdk/runtime/cost-tracker',
  '@deduvafork/squad-sdk/adp',
  '@deduvafork/squad-sdk/config/vendors',
];

/** squad-sdk subpaths only `src/arms/swarm.ts` may import (PLAN §0.9). */
const SDK_SWARM_ONLY_PREFIXES = [
  '@deduvafork/squad-sdk/coordinator',
  '@deduvafork/squad-sdk/client',
];

/**
 * squad-lab modules duva-bench may import — exactly the reuse map in PLAN §2.
 *
 * All but `scripts/study` have an entry in squad-lab's `exports` map (added in
 * S0; asserted below). `scripts/study` is the factorial runner S4 generalizes
 * rather than consumes, so it is permitted here but has no exports entry yet —
 * S4 adds one if it turns out to import rather than transliterate.
 *
 * `harnesses/native` joined the map in S1, and it is the reason the squad-native
 * arm did not need §0.9's `client/*` rule relaxed. That arm *is*
 * `SquadClient.createSession`, so something has to import `client`; putting
 * that import in squad-lab beside the neutral loop — which has always been a
 * standalone factory — keeps duva-bench's side of the fence clean and leaves
 * `src/arms/swarm.ts` the only file here that will ever name the coordinator.
 */
const LAB_ALLOWED = [
  '@deduvafork/squad-lab/adp',
  '@deduvafork/squad-lab/conformance',
  '@deduvafork/squad-lab/grader',
  '@deduvafork/squad-lab/harness',
  '@deduvafork/squad-lab/harnesses/ai-sdk',
  '@deduvafork/squad-lab/harnesses/native',
  '@deduvafork/squad-lab/isolate',
  '@deduvafork/squad-lab/pricing',
  '@deduvafork/squad-lab/summary',
  '@deduvafork/squad-lab/tools/default',
  '@deduvafork/squad-lab/tools/jail',
  '@deduvafork/squad-lab/tools/taxonomy',
  '@deduvafork/squad-lab/variance',
  '@deduvafork/squad-lab/variants',
  '@deduvafork/squad-lab/scripts/study',
];

/** The file — and the only file — carrying the coordinator exemption. */
const SWARM_ARM = 'src/arms/swarm.ts';

// ─── Reading imports ─────────────────────────────────────────────────────

export interface SourceFile {
  /** Path relative to `packages/duva-bench`, e.g. `src/runner.ts`. */
  relPath: string;
  text: string;
}

export interface Violation {
  relPath: string;
  specifier: string;
  reason: string;
}

/**
 * Every module specifier a file depends on, via the TypeScript parser.
 *
 * A regex over the text would also match specifiers quoted inside comments and
 * strings — and this package's files talk about the forbidden imports at
 * length, in exactly that form. Parsing is the difference between a fence and
 * a fence that cries wolf.
 */
export function collectSpecifiers(text: string, fileName = 'file.ts'): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];

  const literal = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) literal(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  };

  walk(source);
  return found;
}

/** Package name of a bare specifier: `@scope/pkg/deep` → `@scope/pkg`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

// ─── The rule ────────────────────────────────────────────────────────────

/**
 * Judge one file's imports.
 *
 * @param declaredDeps Bare packages `packages/duva-bench/package.json` declares.
 *   Anything else from npm is a violation too: an undeclared dependency is a
 *   package that will not install when this tree is extracted.
 */
export function findViolations(files: SourceFile[], declaredDeps: Set<string>): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const isSwarmArm = file.relPath === SWARM_ARM;

    for (const specifier of collectSpecifiers(file.text, file.relPath)) {
      const reject = (reason: string) =>
        violations.push({ relPath: file.relPath, specifier, reason });

      if (isBuiltin(specifier)) continue;

      if (specifier.startsWith('.')) {
        const target = resolve(BENCH_ROOT, dirname(file.relPath), specifier);
        const inside = relative(BENCH_SRC, target);
        if (inside.startsWith('..') || inside.startsWith(sep)) {
          reject('relative import escapes packages/duva-bench/src — cross-package access must use a package name so the boundary can see it');
        }
        continue;
      }

      const pkg = packageOf(specifier);

      if (pkg === '@deduvafork/squad-sdk') {
        if (SDK_ALLOWED.includes(specifier)) continue;
        if (SDK_SWARM_ONLY_PREFIXES.some((p) => specifier === p || specifier.startsWith(`${p}/`))) {
          if (isSwarmArm) continue;
          reject(`coordinator/client may be imported only by ${SWARM_ARM}`);
          continue;
        }
        reject(
          specifier === pkg
            ? 'the squad-sdk root barrel exports everything, coordinator included — import a specific allowed subpath'
            : `not on the squad-sdk allowlist (${SDK_ALLOWED.join(', ')})`
        );
        continue;
      }

      if (pkg === '@deduvafork/squad-lab') {
        if (LAB_ALLOWED.includes(specifier)) continue;
        reject(
          specifier === pkg
            ? "squad-lab's root barrel re-exports runVariant, which imports SquadCoordinator — import a named subpath instead"
            : 'not in the PLAN §2 reuse map'
        );
        continue;
      }

      if (pkg === '@deduvafork/squad-cli') {
        reject('duva-bench never depends on the CLI');
        continue;
      }

      if (!declaredDeps.has(pkg)) {
        reject(`'${pkg}' is not declared in packages/duva-bench/package.json`);
      }
    }
  }

  return violations;
}

// ─── Fixtures ────────────────────────────────────────────────────────────

function benchSources(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push({
          relPath: relative(BENCH_ROOT, abs).split(sep).join('/'),
          text: readFileSync(abs, 'utf8'),
        });
      }
    }
  };
  walk(BENCH_SRC);
  return files;
}

function declaredDeps(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(BENCH_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

const synthetic = (relPath: string, text: string): SourceFile[] => [{ relPath, text }];
const DEPS = new Set(['@deduvafork/squad-sdk', '@deduvafork/squad-lab', 'zod']);

// ─── Tests ───────────────────────────────────────────────────────────────

describe('duva-bench import boundary', () => {
  it('holds across every file in packages/duva-bench/src', () => {
    const files = benchSources();
    expect(files.length).toBeGreaterThan(0);

    const violations = findViolations(files, declaredDeps());
    const rendered = violations.map((v) => `${v.relPath}: '${v.specifier}' — ${v.reason}`);
    expect(rendered).toEqual([]);
  });

  it('reads specifiers by parsing, so prose about forbidden imports is not a violation', () => {
    const text = `
      /** Never import '@deduvafork/squad-sdk/coordinator' from here. */
      const doc = "see @deduvafork/squad-lab for runVariant";
      import { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';
    `;
    expect(collectSpecifiers(text)).toEqual(['@deduvafork/squad-sdk/runtime/event-bus']);
    expect(findViolations(synthetic('src/runner.ts', text), DEPS)).toEqual([]);
  });

  it('sees import, export-from, dynamic import and require alike', () => {
    const text = `
      import a from 'node:fs';
      import type { B } from '@deduvafork/squad-lab/harness';
      export { c } from '@deduvafork/squad-sdk/adp';
      const d = await import('@deduvafork/squad-sdk/coordinator');
      const e = require('@deduvafork/squad-cli');
    `;
    expect(collectSpecifiers(text)).toEqual([
      'node:fs',
      '@deduvafork/squad-lab/harness',
      '@deduvafork/squad-sdk/adp',
      '@deduvafork/squad-sdk/coordinator',
      '@deduvafork/squad-cli',
    ]);
    expect(findViolations(synthetic('src/runner.ts', text), DEPS).map((v) => v.specifier)).toEqual([
      '@deduvafork/squad-sdk/coordinator',
      '@deduvafork/squad-cli',
    ]);
  });

  describe('rejects', () => {
    const cases: Array<[string, string, string]> = [
      ['the squad-sdk root barrel', 'src/runner.ts', "import x from '@deduvafork/squad-sdk';"],
      ['an unlisted squad-sdk subpath', 'src/runner.ts', "import x from '@deduvafork/squad-sdk/agents';"],
      ['the squad-lab root barrel', 'src/runner.ts', "import x from '@deduvafork/squad-lab';"],
      ['a squad-lab module outside the reuse map', 'src/runner.ts', "import x from '@deduvafork/squad-lab/run-variant';"],
      ['the squad CLI', 'src/runner.ts', "import x from '@deduvafork/squad-cli';"],
      ['an undeclared npm package', 'src/runner.ts', "import x from 'lodash';"],
      ['a relative import that leaves the package', 'src/runner.ts', "import x from '../../squad-lab/src/run-variant.js';"],
      ['a relative import that leaves from a nested file', 'src/arms/native.ts', "import x from '../../../squad-lab/src/run-variant.js';"],
      ['the coordinator outside the swarm arm', 'src/arms/native.ts', "import { SquadCoordinator } from '@deduvafork/squad-sdk/coordinator';"],
      ['the client outside the swarm arm', 'src/runner.ts', "import x from '@deduvafork/squad-sdk/client';"],
    ];

    it.each(cases)('%s', (_name, relPath, text) => {
      const violations = findViolations(synthetic(relPath, text), DEPS);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toBeTruthy();
    });
  });

  describe('allows', () => {
    const cases: Array<[string, string, string]> = [
      ...SDK_ALLOWED.map(
        (s) => ['sdk: ' + s, 'src/runner.ts', `import x from '${s}';`] as [string, string, string]
      ),
      ...LAB_ALLOWED.map(
        (s) => ['lab: ' + s, 'src/runner.ts', `import x from '${s}';`] as [string, string, string]
      ),
      ['a declared npm package', 'src/study.ts', "import { z } from 'zod';"],
      ['a node builtin', 'src/runner.ts', "import { readFileSync } from 'node:fs';"],
      ['a relative import inside the package', 'src/arms/native.ts', "import x from '../runner.js';"],
    ];

    it.each(cases)('%s', (_name, relPath, text) => {
      expect(findViolations(synthetic(relPath, text), DEPS)).toEqual([]);
    });
  });

  it('exempts src/arms/swarm.ts, and only it, for coordinator and client', () => {
    const text = `
      import { SquadCoordinator } from '@deduvafork/squad-sdk/coordinator';
      import { createClient } from '@deduvafork/squad-sdk/client';
    `;
    expect(findViolations(synthetic('src/arms/swarm.ts', text), DEPS)).toEqual([]);
    expect(findViolations(synthetic('src/arms/swarm-helper.ts', text), DEPS)).toHaveLength(2);
  });
});

describe('squad-lab exports map', () => {
  const exportsMap = (
    JSON.parse(readFileSync(join(LAB_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, string>;
    }
  ).exports;

  it('publishes every reuse-map module the boundary allows', () => {
    // `scripts/study` is generalized rather than imported; see LAB_ALLOWED.
    const needed = LAB_ALLOWED.filter((s) => s !== '@deduvafork/squad-lab/scripts/study').map(
      (s) => '.' + s.slice('@deduvafork/squad-lab'.length)
    );
    expect(Object.keys(exportsMap ?? {}).sort()).toEqual(needed.sort());
  });

  it('resolves each entry to a file that exists', () => {
    for (const [subpath, target] of Object.entries(exportsMap ?? {})) {
      expect(existsSync(join(LAB_ROOT, target)), `${subpath} → ${target}`).toBe(true);
    }
  });

  it('is what a subpath import actually resolves through', async () => {
    // The entries point at `src/*.ts` rather than `dist/*.js`: squad-lab is a
    // private workspace package consumed only under tsx and vitest, both of
    // which resolve TypeScript, and pointing at dist would make every
    // duva-bench test run depend on a squad-lab build that the root `build`
    // script does not perform. This asserts the choice actually works.
    const harness = await import('@deduvafork/squad-lab/harness');
    expect(typeof harness.harnessDigest).toBe('function');
  });

  it('does not publish the root barrel, which would reach run-variant and the coordinator', () => {
    // Not `toHaveProperty('.')` — the matcher reads a dot as a path separator.
    expect(Object.keys(exportsMap ?? {})).not.toContain('.');
  });
});
