/**
 * The study spec: what is being compared, how many times, and — decided before
 * anything runs — what would count as an answer.
 *
 * Two properties carry the weight here, and both are about what a reader can
 * check rather than what a write-up asserts.
 *
 * **The digest.** A study is a content-addressed value. Reorder its keys, write
 * the arms in a different order, load it from YAML instead of JSON: same
 * digest. Change a model, a toolset, a docs grade, a repetition count, the
 * grader: different digest. That is what makes "these trials belong to this
 * study" a fact rather than a filing convention, and it is why the digest is
 * computed over a *normalized* value rather than over the file bytes. The
 * canonicalization is squad-lab's own `canonicalJson` — the same code path ADP
 * agrees with, which the m5 check established — so a digest computed here and a
 * digest computed there are the same number.
 *
 * **Pre-registration.** `PreRegistration` names the primary metric, the
 * repetition count and the exclusion rules before execution. It may be amended;
 * research that could never be amended would just be research that lies later.
 * What it may not do is amend *invisibly*, so every amendment records the value
 * it replaced, and `preAmendmentOf` unwinds them to reconstruct exactly what was
 * registered. Both readings are digestible, so a report can print "registered X,
 * amended to Y, here is the reading under each" — which is the only version of
 * an amendment a sceptical reader should accept.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '@deduvafork/squad-lab/grader';
import { z } from 'zod';

// ─── Refs ────────────────────────────────────────────────────────────────

/**
 * A task is a triple, and the grader's own bytes are part of its identity.
 *
 * `graderSha256` is not metadata. Two studies that ran "the same task" under
 * graders that differ by a line are not comparable, and the only way for that
 * to be visible is for the grader's digest to move the task's digest — and
 * therefore the study's.
 */
export const TaskRef = z
  .object({
    id: z.string().min(1),
    /** The brief. Filed as an ADP issue, which is what mints the intent. */
    goal: z.string().min(1),
    /** Seed repository the trial clones. */
    seed: z.string().min(1),
    grader: z.string().min(1),
    graderSha256: z.string().regex(/^[0-9a-f]{64}$/, 'grader sha256 must be 64 hex chars'),
  })
  .strict();
export type TaskRef = z.infer<typeof TaskRef>;

export const Provider = z.enum(['anthropic', 'gemini']);
export const Tier = z.enum(['premium', 'standard', 'fast']);

/**
 * `provider[:tier][@model]`, the grammar squad-lab already uses.
 *
 * A tier alone means "whatever the registry calls that tier today" — the right
 * default for a first run and the wrong one for a result you intend to cite,
 * which is why a pinned `model` is representable and recorded distinctly.
 */
export const ModelRef = z
  .object({
    provider: Provider,
    tier: Tier.optional(),
    model: z.string().min(1).optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRef>;

export const HarnessRef = z.enum(['squad-native', 'ai-sdk']);
export type HarnessRef = z.infer<typeof HarnessRef>;

/**
 * How much the agent is told about its tools.
 *
 * The Study A instrument: `none` is the twin with no documentation, `reference`
 * is a signature list, `rich` adds worked examples. Part of the arm digest
 * because two arms differing only in docs are, deliberately, different harnesses.
 */
export const DocsGrade = z.enum(['none', 'reference', 'rich']);
export type DocsGrade = z.infer<typeof DocsGrade>;

export const ToolsetRef = z
  .object({
    name: z.string().min(1),
    docsGrade: DocsGrade.default('none'),
    /** Seed for the twin generator (S3). Absent means the standard toolset. */
    twinSeed: z.string().min(1).optional(),
  })
  .strict();
export type ToolsetRef = z.infer<typeof ToolsetRef>;

/** Spec'd now, wired in S4. `openArm` refuses `swarm` until then. */
export const Topology = z.enum(['single', 'swarm']);
export type Topology = z.infer<typeof Topology>;

export const Arm = z
  .object({
    id: z.string().min(1),
    model: ModelRef,
    harness: HarnessRef,
    toolset: ToolsetRef,
    topology: Topology.default('single'),
  })
  .strict();
export type Arm = z.infer<typeof Arm>;

// ─── Pre-registration ────────────────────────────────────────────────────

/**
 * One amendment, carrying the value it replaced.
 *
 * `from` is what makes the amendment honest: without it the registered value is
 * gone and "we always said the primary metric was X" is unfalsifiable.
 */
export const Amendment = z
  .object({
    at: z.string().min(1),
    field: z.string().min(1),
    from: z.unknown(),
    to: z.unknown(),
    reason: z.string().min(1),
  })
  .strict();
export type Amendment = z.infer<typeof Amendment>;

/**
 * An exclusion decided in advance.
 *
 * m14 had to drop `gemini-pro-latest` after quota errors on 8 of 10 runs, and
 * including it had inflated the noise floor 14×. That was the right call and it
 * was made after seeing the data, which is exactly the move a pre-registration
 * exists to constrain. Exclusions are therefore written down first and printed
 * with their counts in the report.
 */
export const ExclusionRule = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type ExclusionRule = z.infer<typeof ExclusionRule>;

export const PreRegistration = z
  .object({
    primaryMetric: z.string().min(1),
    secondaryMetrics: z.array(z.string().min(1)).default([]),
    repetitions: z.number().int().positive(),
    exclusionRules: z.array(ExclusionRule).default([]),
    amendments: z.array(Amendment).default([]),
  })
  .strict();
export type PreRegistration = z.infer<typeof PreRegistration>;

export const Study = z
  .object({
    title: z.string().min(1),
    tasks: z.array(TaskRef).min(1),
    arms: z.array(Arm).min(1),
    /** Budget ceiling in USD. The scheduler (S4) checks it before each trial. */
    budgetUsd: z.number().positive(),
    concurrency: z.number().int().positive().default(1),
    preRegistration: PreRegistration,
  })
  .strict()
  .superRefine((study, ctx) => {
    const duplicate = (values: string[]) =>
      values.find((value, index) => values.indexOf(value) !== index);

    // Ids are how a trial names its cell in `external_ref`, and two arms
    // sharing one would make two different cells indistinguishable in ADP.
    const armId = duplicate(study.arms.map((a) => a.id));
    if (armId) ctx.addIssue({ code: 'custom', message: `duplicate arm id '${armId}'`, path: ['arms'] });

    const taskId = duplicate(study.tasks.map((t) => t.id));
    if (taskId) ctx.addIssue({ code: 'custom', message: `duplicate task id '${taskId}'`, path: ['tasks'] });

    if (study.preRegistration.repetitions < 1) {
      ctx.addIssue({ code: 'custom', message: 'repetitions must be at least 1', path: ['preRegistration'] });
    }
  });
export type Study = z.infer<typeof Study>;

// ─── Digests ─────────────────────────────────────────────────────────────

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Digest any value the way ADP and squad-lab already agree on.
 *
 * `canonicalJson` sorts keys recursively and drops `undefined`, so a digest is
 * a property of the content rather than of how it was written down.
 */
export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * What an arm *is*, for digest purposes.
 *
 * The id is excluded deliberately: renaming an arm must not make it a different
 * arm, or re-running a study after a tidy-up would look like a new experiment.
 * Everything that changes the program the agent runs is included.
 */
export function armFingerprint(arm: Arm): Record<string, unknown> {
  return {
    model: arm.model,
    harness: arm.harness,
    toolset: arm.toolset,
    topology: arm.topology,
  };
}

export function armDigest(arm: Arm): string {
  return digestOf(armFingerprint(arm));
}

/**
 * What a study is, for digest purposes.
 *
 * Arms and tasks are sorted by id so that reordering the file does not restate
 * the experiment, while `concurrency` is excluded because it is a scheduling
 * decision: running the same study four-at-a-time rather than serially does not
 * make it a different study, and pretending otherwise would prevent resuming a
 * study at a different width.
 */
export function studyFingerprint(study: Study): Record<string, unknown> {
  const byId = <T extends { id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));

  return {
    title: study.title,
    tasks: byId(study.tasks),
    arms: byId(study.arms).map((arm) => ({ id: arm.id, ...armFingerprint(arm) })),
    budgetUsd: study.budgetUsd,
    preRegistration: study.preRegistration,
  };
}

export function studyDigest(study: Study): string {
  return digestOf(studyFingerprint(study));
}

/** The 12-char prefix used in intent titles and `external_ref` (PLAN §S4). */
export const shortDigest = (digest: string): string => digest.slice(0, 12);

// ─── Pre-registration readings ───────────────────────────────────────────

/**
 * Reconstruct what was registered, by unwinding amendments newest-first.
 *
 * Only top-level fields are amendable, and deliberately so: an amendment that
 * could reach into an arbitrary path would be a diff, and a diff is not
 * something a reader can check at a glance. Unknown fields are rejected rather
 * than ignored, because silently failing to unwind would produce a "pre-
 * amendment" reading that never existed.
 */
export function preAmendmentOf(prereg: PreRegistration): PreRegistration {
  const amendable = new Set(['primaryMetric', 'secondaryMetrics', 'repetitions', 'exclusionRules']);
  const unwound: Record<string, unknown> = { ...prereg, amendments: [] };

  for (const amendment of [...prereg.amendments].reverse()) {
    if (!amendable.has(amendment.field)) {
      throw new Error(
        `amendment targets '${amendment.field}', which is not an amendable pre-registration field`,
      );
    }
    unwound[amendment.field] = amendment.from;
  }

  return PreRegistration.parse(unwound);
}

export interface PreRegistrationReading {
  registered: PreRegistration;
  current: PreRegistration;
  registeredDigest: string;
  currentDigest: string;
  amended: boolean;
}

/** Both readings and both digests, which is what a report must print. */
export function preRegistrationReading(prereg: PreRegistration): PreRegistrationReading {
  const registered = preAmendmentOf(prereg);
  return {
    registered,
    current: prereg,
    registeredDigest: digestOf(registered),
    currentDigest: digestOf(prereg),
    amended: prereg.amendments.length > 0,
  };
}

// ─── Loading ─────────────────────────────────────────────────────────────

export interface ValidationFailure {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; study: Study }
  | { ok: false; errors: ValidationFailure[] };

/** Validate an already-parsed value. Never throws — the CLI prints the list. */
export function parseStudy(value: unknown): ParseResult {
  const result = Study.safeParse(value);
  if (result.success) return { ok: true, study: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
