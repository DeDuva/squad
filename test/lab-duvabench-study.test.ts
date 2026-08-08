/**
 * The study digest, and what it must and must not notice.
 *
 * A digest that moves for everything is a serial number: it cannot say two
 * studies are the same, so nothing can be resumed or joined. A digest that
 * moves for nothing is worse — it lets a changed grader, a swapped model or a
 * quietly-edited pre-registration ride along inside "the same study".
 *
 * So both halves are tested exhaustively rather than by example. Every field
 * group that describes *what the experiment is* must move the digest, and the
 * two that describe *how it was typed or scheduled* must not. When a field is
 * added to the schema, the sensitivity table below should grow with it — a
 * field nobody added a case for is a field the digest may silently ignore.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  armDigest,
  parseStudy,
  preAmendmentOf,
  preRegistrationReading,
  studyDigest,
  type PreRegistration,
  type Study,
} from '../packages/duva-bench/src/study.js';
import { loadStudyFile } from '../packages/duva-bench/src/study-file.js';
import { describeStudyFile } from '../packages/duva-bench/src/study-report.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const GRADER_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

const baseStudy = () => ({
  title: 'smoke',
  tasks: [
    { id: 'retry', goal: 'retry/goal.md', seed: 'retry/seed', grader: 'retry/g.mjs', graderSha256: GRADER_SHA },
    { id: 'semver', goal: 'semver/goal.md', seed: 'semver/seed', grader: 'semver/g.mjs', graderSha256: GRADER_SHA },
  ],
  arms: [
    {
      id: 'native',
      harness: 'squad-native',
      model: { provider: 'anthropic', tier: 'fast' },
      toolset: { name: 'default', docsGrade: 'reference' },
      topology: 'single',
    },
    {
      id: 'neutral',
      harness: 'ai-sdk',
      model: { provider: 'anthropic', tier: 'fast' },
      toolset: { name: 'default', docsGrade: 'reference' },
      topology: 'single',
    },
  ],
  budgetUsd: 5,
  concurrency: 2,
  preRegistration: {
    primaryMetric: 'acceptance',
    secondaryMetrics: ['tokensIn'],
    repetitions: 2,
    exclusionRules: [{ id: 'quota', description: 'provider quota errors' }],
    amendments: [],
  },
});

function parsed(mutate: (draft: ReturnType<typeof baseStudy>) => void = () => {}): Study {
  const draft = baseStudy();
  mutate(draft);
  const result = parseStudy(draft);
  if (!result.ok) throw new Error(`fixture did not parse: ${JSON.stringify(result.errors)}`);
  return result.study;
}

const digestOfStudy = (mutate?: (d: ReturnType<typeof baseStudy>) => void) => studyDigest(parsed(mutate));

// ─── Stability ───────────────────────────────────────────────────────────

describe('study digest stability', () => {
  const baseline = digestOfStudy();

  it('is unchanged by key order', () => {
    // The same study, written inside-out. `canonicalJson` sorts recursively, so
    // this must be the same number or the digest is a property of the typing.
    const reordered = parseStudy({
      preRegistration: {
        amendments: [],
        exclusionRules: [{ description: 'provider quota errors', id: 'quota' }],
        repetitions: 2,
        secondaryMetrics: ['tokensIn'],
        primaryMetric: 'acceptance',
      },
      concurrency: 2,
      budgetUsd: 5,
      arms: baseStudy().arms.map((a) => ({
        topology: a.topology,
        toolset: { docsGrade: a.toolset.docsGrade, name: a.toolset.name },
        model: { tier: a.model.tier, provider: a.model.provider },
        harness: a.harness,
        id: a.id,
      })),
      tasks: baseStudy().tasks.map((t) => ({
        graderSha256: t.graderSha256,
        grader: t.grader,
        seed: t.seed,
        goal: t.goal,
        id: t.id,
      })),
      title: 'smoke',
    });
    if (!reordered.ok) throw new Error('reordered fixture did not parse');
    expect(studyDigest(reordered.study)).toBe(baseline);
  });

  it('is unchanged by the order arms and tasks are listed in', () => {
    expect(digestOfStudy((d) => d.arms.reverse())).toBe(baseline);
    expect(digestOfStudy((d) => d.tasks.reverse())).toBe(baseline);
  });

  it('is unchanged by concurrency, which is a scheduling decision', () => {
    // Otherwise a study could not be resumed at a different width without
    // becoming, on paper, a different experiment.
    expect(digestOfStudy((d) => { d.concurrency = 8; })).toBe(baseline);
  });

  it('is the same whether the study was written as YAML or as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duvabench-study-'));
    try {
      const asJson = join(dir, 'study.json');
      const asYaml = join(dir, 'study.yaml');
      writeFileSync(asJson, JSON.stringify(baseStudy(), null, 2));
      writeFileSync(
        asYaml,
        [
          'title: smoke',
          'tasks:',
          `  - {id: retry, goal: retry/goal.md, seed: retry/seed, grader: retry/g.mjs, graderSha256: "${GRADER_SHA}"}`,
          `  - {id: semver, goal: semver/goal.md, seed: semver/seed, grader: semver/g.mjs, graderSha256: "${GRADER_SHA}"}`,
          'arms:',
          '  - id: native',
          '    harness: squad-native',
          '    model: {provider: anthropic, tier: fast}',
          '    toolset: {name: default, docsGrade: reference}',
          '    topology: single',
          '  - id: neutral',
          '    harness: ai-sdk',
          '    model: {provider: anthropic, tier: fast}',
          '    toolset: {name: default, docsGrade: reference}',
          '    topology: single',
          'budgetUsd: 5',
          'concurrency: 2',
          'preRegistration:',
          '  primaryMetric: acceptance',
          '  secondaryMetrics: [tokensIn]',
          '  repetitions: 2',
          '  exclusionRules: [{id: quota, description: provider quota errors}]',
          '  amendments: []',
          '',
        ].join('\n'),
      );

      // `hashGraders: false` — these fixtures name graders that do not exist,
      // and the point here is the format, not the file system.
      const fromJson = loadStudyFile(asJson, { hashGraders: false });
      const fromYaml = loadStudyFile(asYaml, { hashGraders: false });
      if (!fromJson.ok || !fromYaml.ok) {
        throw new Error(`did not parse: ${JSON.stringify({ fromJson, fromYaml })}`);
      }
      expect(studyDigest(fromYaml.study)).toBe(studyDigest(fromJson.study));
      expect(studyDigest(fromJson.study)).toBe(baseline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Sensitivity ─────────────────────────────────────────────────────────

describe('study digest sensitivity', () => {
  const baseline = digestOfStudy();

  const cases: Array<[string, (d: ReturnType<typeof baseStudy>) => void]> = [
    ['the title', (d) => { d.title = 'other'; }],
    ['an arm id', (d) => { d.arms[0]!.id = 'renamed'; }],
    ['a task id', (d) => { d.tasks[0]!.id = 'renamed'; }],
    ['the goal path', (d) => { d.tasks[0]!.goal = 'elsewhere/goal.md'; }],
    ['the seed', (d) => { d.tasks[0]!.seed = 'elsewhere/seed'; }],
    ['the grader path', (d) => { d.tasks[0]!.grader = 'elsewhere/g.mjs'; }],
    ['the grader bytes', (d) => { d.tasks[0]!.graderSha256 = OTHER_SHA; }],
    ['the provider', (d) => { d.arms[0]!.model.provider = 'gemini'; }],
    ['the tier', (d) => { d.arms[0]!.model.tier = 'premium'; }],
    ['a pinned model', (d) => { (d.arms[0]!.model as Record<string, unknown>).model = 'claude-sonnet-5'; }],
    ['the harness', (d) => { d.arms[0]!.harness = 'ai-sdk'; }],
    ['the toolset name', (d) => { d.arms[0]!.toolset.name = 'twin'; }],
    ['the docs grade', (d) => { d.arms[0]!.toolset.docsGrade = 'rich'; }],
    ['the twin seed', (d) => { (d.arms[0]!.toolset as Record<string, unknown>).twinSeed = 'seed-1'; }],
    ['the topology', (d) => { d.arms[0]!.topology = 'swarm'; }],
    ['the budget', (d) => { d.budgetUsd = 50; }],
    ['the primary metric', (d) => { d.preRegistration.primaryMetric = 'hallucinatedCallRate'; }],
    ['the secondary metrics', (d) => { d.preRegistration.secondaryMetrics = ['cost']; }],
    ['the repetition count', (d) => { d.preRegistration.repetitions = 5; }],
    ['an exclusion rule', (d) => { d.preRegistration.exclusionRules[0]!.description = 'something else'; }],
    ['adding an exclusion rule', (d) => { d.preRegistration.exclusionRules.push({ id: 'x', description: 'y' }); }],
  ];

  it.each(cases)('moves when %s changes', (_name, mutate) => {
    expect(digestOfStudy(mutate)).not.toBe(baseline);
  });

  it('gives arms that differ only by harness different arm digests', () => {
    const study = parsed();
    expect(armDigest(study.arms[0]!)).not.toBe(armDigest(study.arms[1]!));
  });

  it('does not let a rename change what an arm is', () => {
    // The study digest moves — the study now names a different cell — but the
    // arm itself is unchanged, so its digest must not move. Otherwise tidying
    // up a name would orphan every trial already recorded against that arm.
    const before = armDigest(parsed().arms[0]!);
    const after = armDigest(parsed((d) => { d.arms[0]!.id = 'renamed'; }).arms[0]!);
    expect(after).toBe(before);
  });
});

// ─── Pre-registration ────────────────────────────────────────────────────

describe('pre-registration amendments', () => {
  const amended = (): PreRegistration => ({
    primaryMetric: 'hallucinatedCallRate',
    secondaryMetrics: ['tokensIn'],
    repetitions: 5,
    exclusionRules: [{ id: 'quota', description: 'provider quota errors' }],
    amendments: [
      {
        at: '2026-08-08',
        field: 'repetitions',
        from: 2,
        to: 5,
        reason: 'noise floor wider than expected',
      },
      {
        at: '2026-08-09',
        field: 'primaryMetric',
        from: 'acceptance',
        to: 'hallucinatedCallRate',
        reason: 'acceptance saturated on both arms',
      },
    ],
  });

  it('reconstructs exactly what was registered', () => {
    const registered = preAmendmentOf(amended());
    expect(registered.primaryMetric).toBe('acceptance');
    expect(registered.repetitions).toBe(2);
    expect(registered.amendments).toEqual([]);
  });

  it('keeps both readings computable, with different digests', () => {
    const reading = preRegistrationReading(amended());
    expect(reading.amended).toBe(true);
    expect(reading.registeredDigest).not.toBe(reading.currentDigest);
    // The whole point: a report can print the original alongside the current
    // one, so an amendment is visible rather than merely permitted.
    expect(reading.registered.primaryMetric).toBe('acceptance');
    expect(reading.current.primaryMetric).toBe('hallucinatedCallRate');
  });

  it('is a no-op reading when nothing was amended', () => {
    const prereg = { ...amended(), amendments: [] };
    const reading = preRegistrationReading(prereg);
    expect(reading.amended).toBe(false);
    expect(reading.registeredDigest).toBe(reading.currentDigest);
  });

  it('refuses an amendment to a field it cannot unwind', () => {
    const prereg = amended();
    prereg.amendments = [
      { at: '2026-08-08', field: 'somethingElse', from: 1, to: 2, reason: 'nope' },
    ];
    // Silently ignoring it would produce a "pre-amendment" reading that never
    // existed, which is worse than refusing.
    expect(() => preAmendmentOf(prereg)).toThrow(/not an amendable/);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────

describe('study validation', () => {
  const errorsFor = (mutate: (d: ReturnType<typeof baseStudy>) => void): string[] => {
    const draft = baseStudy();
    mutate(draft);
    const result = parseStudy(draft);
    if (result.ok) return [];
    return result.errors.map((e) => `${e.path}: ${e.message}`);
  };

  it('rejects duplicate arm ids, which would make two cells indistinguishable', () => {
    expect(errorsFor((d) => { d.arms[1]!.id = 'native'; }).join('\n')).toMatch(/duplicate arm id 'native'/);
  });

  it('rejects duplicate task ids', () => {
    expect(errorsFor((d) => { d.tasks[1]!.id = 'retry'; }).join('\n')).toMatch(/duplicate task id 'retry'/);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // A typo in a spec key is a silent change of experiment otherwise.
    expect(errorsFor((d) => { (d as Record<string, unknown>).repetitions = 3; })).not.toEqual([]);
  });

  it('rejects a grader digest that is not a sha256', () => {
    expect(errorsFor((d) => { d.tasks[0]!.graderSha256 = 'nope'; }).join('\n')).toMatch(/64 hex/);
  });

  it('reports every problem at once, not just the first', () => {
    const errors = errorsFor((d) => {
      d.title = '';
      d.tasks[0]!.graderSha256 = 'nope';
      d.budgetUsd = -1;
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts the committed smoke study', () => {
    const result = loadStudyFile('packages/duva-bench/examples/smoke-study.yaml');
    expect(result.ok).toBe(true);
  });
});

// ─── The commands ────────────────────────────────────────────────────────

describe('validate and digest commands', () => {
  const SPEC = 'packages/duva-bench/examples/smoke-study.yaml';

  it('validates the committed smoke study and finds every referenced path', () => {
    const out = describeStudyFile(SPEC, 'validate');
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^ok — 2 task\(s\), 2 arm\(s\)/);
    // The example points at real squad-lab tasks; a warning here means the
    // reuse map moved and the example went stale with it.
    expect(out.stdout).not.toMatch(/warning/);
  });

  it('prints both digests and the trial count', () => {
    const out = describeStudyFile(SPEC, 'digest');
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/digest {3}[0-9a-f]{64}/);
    expect(out.stdout).toMatch(/trials {3}2 tasks x 2 arms x 2 reps = 8/);
  });

  it('exits non-zero and lists every problem for a bad spec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duvabench-bad-'));
    try {
      const bad = join(dir, 'bad.yaml');
      writeFileSync(bad, 'title: ""\ntasks: []\narms: []\nbudgetUsd: -1\n');
      const out = describeStudyFile(bad, 'validate');
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(/problem\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unreadable file as a different kind of failure', () => {
    const out = describeStudyFile('packages/duva-bench/examples/nope.yaml', 'digest');
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/ENOENT|no such file/);
  });
});
