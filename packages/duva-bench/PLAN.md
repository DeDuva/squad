# duva-bench (squad track) — Execution Plan (v0.1)

An execution-grade plan for building **the squad-track variant of duva-bench**: the same
researcher app — define, execute, analyze controlled factorial experiments over coding-agent
arms — built as a package **inside the squad fork**, on squad-lab's verified-separable modules.
Written to be followed **in order** by an AI coding agent (Sonnet-class) without strategic
context. Each task states its deliverable and done-condition. Gates (SG1–SG3) are hard stops.

This track runs **in parallel** with the Harbor track
(github.com/DeDuva/duva-bench, `docs/execution-plan.md` there). The two tracks share the ADP
record, the task/grader format, and the statistics code path, and diverge only in the execution
layer — which makes the pair itself an experiment (see §6).

**Repo:** `~/dev/duva_squad/squad` (fork of upstream squad, github.com/DeDuva/squad).
**Base branch: `dev`** — the default branch as of 2026-08-07; `origin/dev` ==
`origin/replatform-0.11` (`99f60910`), so all prior lab work (PRs #74–#89) is on it.
Milestone reports for prior work: **`github.com/DeDuva/duva-lab-tpm`** (private), `reports/m0…m14`
— moved there 2026-08-08 from an untracked directory that had no remote.

---

## Track status — 2026-08-08

**Both tracks are meant to run in parallel. That is the design, not a schedule slip.** The pair is
itself the experiment: bespoke infrastructure (this track) against in-distribution infrastructure
(Harbor), on the same tasks, graders and statistics. Neither track is the "real" one.

| Track | State |
|---|---|
| **squad** (this plan) | S0–S7 executed and merged; gates SG1 and SG2 passed. S7 ran a live 24-trial pilot, $8.03, every run verified. |
| **Harbor** (`github.com/DeDuva/duva-bench`) | **Paused, deliberately.** Still at its bootstrap commit — README, licence, docs site, execution plan. No tasks, graders or runs. |

**Why Harbor is paused:** its dependencies could not be configured from a remote session. That is
an environment constraint, and the pause is a decision — **not neglect, and not a reversal of the
substrate decision.** It is written down here because a bootstrap-only repository is otherwise
indistinguishable from an abandoned one: a cross-project audit on 2026-08-08 read it as exactly
that, which is the evidence that leaving it unrecorded was itself the defect.

**What would resume it.** A later probe found `terminal-bench` installs cleanly on this machine
and Docker runs and pulls images, so the dependency picture may be better than when the pause was
taken. But Harbor also wraps real agent CLIs and only `claude` is present locally (`codex` and
`aider` are absent), so the obstacle may have been elsewhere. The next step is **one timeboxed
probe of a single Harbor trial**, reporting exactly where it fails — not a restart.

---

## 0. Rules for the executing agent

1. **One milestone per branch, one PR per milestone**, branched from `dev`, PR'd to `dev`. Branch
   name `feat/duva-bench-s<N>-<slug>`. Do not start S(N+1) until S(N) is merged.
2. **Never add commit attribution** (no `Co-Authored-By`, no "Generated with" lines).
3. **`npm test` mutates the working tree**: the acceptance scenario runs `squad init` in
   `process.cwd()`, writing `.mcp.json`, `.github/skills/**`, and a `.gitattributes` line.
   Discard those before committing — they are never part of your change.
4. **Work from a git worktree** of the squad repo, not the main checkout (the checkout may hold
   the user's state). `squad init`'s worktree guard (PR #77) makes `npm test` green from a
   worktree.
5. **ADP identities do not survive `make down`** in the local ADP stack. If contract/live checks
   fail with 401 on `GET /api/v3/user`, re-mint the two principals (runner + grader) with ADP's
   `tsx src/bootstrap.ts <principal>`; see `~/dev/duva_squad/reports/` and the squad-lab README
   for the recipe.
6. **Copy patterns before designing.** The named modules in §2 are the implementation — import
   them or transliterate them; do not reinvent them.
7. **Non-cuttable design rules** (each bought with a documented failure in this repo's own
   reports): rank **per axis, never blended**; **unscored ≠ zero** and unpriced renders
   `unpriced`, never `$0.00`; **digest mismatch ⇒ no comparison** (banded warning instead);
   **evidence gating** — ADP `/verify` not `ok` ⇒ verdict `ERROR`, never pass/fail, and errors
   count **against** the majority; **pre-registration** digested before execution, amendments
   visible with the pre-amendment reading still computable.
8. **Secrets** only from env (`SQUAD_LAB_ADP_TOKEN` runner, `SQUAD_LAB_EVAL_TOKEN` grader,
   provider keys per `~/.config/squad/`). The grader subprocess env must have ADP and provider
   tokens stripped, and its cwd must be outside the graded repo.
9. **The import boundary is law** (and S0 makes it a test): `packages/duva-bench` may import from
   `@deduvafork/squad-sdk` **only** `runtime/event-bus`, `runtime/cost-tracker`, `adp/*`, and
   `config/vendors`; from squad-lab only the modules named in §2. `SquadCoordinator`,
   `coordinator/*`, and `client/*` may be imported **nowhere except** `src/arms/swarm.ts` (S4).
   This boundary is what keeps later extraction to a standalone repo mechanical.

---

## 1. What this builds, and how it differs from the Harbor track

`packages/duva-bench` — an npm-workspace package that defines experiments (content-digested spec
with a pre-registration block), executes them as **in-process TypeScript arms** (squad-native and
AI-SDK harnesses behind the existing `SessionFactory` seam, plus a **topology arm**: single agent
vs. squad swarm), records every trial as a verified ADP run, and analyzes results with a noise
floor and paired statistics.

| | squad track (this plan) | Harbor track |
|---|---|---|
| Arms | in-process TS loops + topology (single vs. swarm) | real agent CLIs (Claude Code, Codex, …) |
| Isolation | fresh clone per variant, path-jailed tools, child process | container per trial |
| Cost/speed | ~$0.35/run, seconds to start | heavier, minutes |
| Ceiling | single-turn quiescence; toy-to-medium tasks | closed-world, long-horizon tasks |
| Unique ability | swarm-vs-single topology as a controlled arm | harness-familiarity arms with real products |

Both tracks label every run with `platform: squad` / `platform: harbor` plus the same arm
descriptor fields, record to the same ADP, and consume the same task triples
(`goal.md` + seed repo + `grader.mjs`) — so Study A can run on both and the platform itself
becomes a measured factor.

---

## 2. Fixed decisions — reuse map (do not revisit)

TypeScript, Node ≥ 22.5, vitest, repo-standard lint. New package `packages/duva-bench`
(`@deduvafork/duva-bench`), `src/` + `test/` in the repo's `test/lab-*` style.

Modules that already exist and MUST be reused (paths relative to `packages/`):

| Module | Provides | Note |
|---|---|---|
| `squad-sdk/src/runtime/event-bus.ts` | `EventBus`, `SquadEvent` | zero imports; fully standalone |
| `squad-sdk/src/runtime/event-payloads.ts` | typed payloads | type-only |
| `squad-sdk/src/adp/{recorder,spool,client,config}.ts` | `AdpRunRecorder` + durable spool | harness-agnostic; imports nothing from coordinator |
| `squad-sdk/src/adp/assignment.ts` | `startAssignmentRecording` / `finishAssignmentRecording` | the coordinator-free run lifecycle |
| `squad-sdk/src/runtime/cost-tracker.ts` | `CostTracker` | |
| `squad-lab/src/harness.ts` | `harnessDigest()` | excludes model by design; folds tools, charters, routing, limits |
| `squad-lab/src/conformance.ts` | `SessionFactory` + 8-clause contract, `harness-check` | every arm must pass it |
| `squad-lab/src/harnesses/ai-sdk.ts` | the neutral loop | reference arm |
| `squad-lab/src/grader.ts` | grader invocation, spec digest, per-axis evals | grader sha256 injected into spec |
| `squad-lab/src/{isolate,tools/default,tools/jail,tools/taxonomy}.ts` | clone-per-variant, path-jailed tools | `safeDir` lesson: every registered tool gets its own contract test |
| `squad-lab/src/{variance,pricing,summary}.ts` | noise floor, price table (`null` never `0`), banded per-axis summary | |
| `squad-lab/src/adp.ts` | the lab's ADP HTTP calls incl. intent-minting via compat-plane issue | |
| `squad-lab/scripts/study.ts` | the factorial runner to generalize | S4's starting point |

If a needed module isn't exported from squad-lab's `package.json`, add the export entry in S0 —
do not copy the file.

**Statistics bridge:** paired stats come from **adp-replay's Python library** so both tracks use
identical stats code. Use `~/dev/adp-replay/.venv/bin/python` (no pip, no installs — the venv
already has what's needed; PyYAML via system `python3` if ever required). duva-bench exports
`outcomes.json`; a small `tools/paired_stats.py` (added to adp-replay or vendored here — prefer a
PR to adp-replay adding an `analyze` CLI) calls `adp_replay.stats.paired`
(`mcnemar_exact`, `bootstrap_ci_over_tasks`, `paired_difference_ci_over_tasks`, `icc`) and adds
Holm correction for >2 arms. All seeded.

**ADP contract: 0.2.0.** Same traps as the Harbor plan §3, all already handled by the reused
modules — trust them: `payload: {}` workaround lives in the recorder; intents are minted by
filing a compat-plane issue (`squad-lab/src/adp.ts:createGoal`); tokens come from ADP's
`bootstrap.ts`; reads are per-intent (200-row cap).

---

## 3. Known traps specific to this track — code around them

1. **`shouldHandleDirectly()` can produce zero-agent runs**: the coordinator's direct-response
   check runs before routing and matches built-in patterns regardless of config, and
   `run-variant.ts` never inspects `result.strategy`. S1 removes the coordinator from the trial
   path entirely, which eliminates the hazard by construction — a test must prove a goal title
   matching a direct-response pattern still spawns an agent.
2. **Single-turn quiescence is this track's ceiling**: agents get one turn; charters must end
   with an explicit "make no further tool calls"; task briefs must be sized accordingly. Do not
   attempt multi-turn work in this plan (see §5).
3. **The runner must emit what the coordinator used to emit**: the terminal `session:destroyed`
   per agent (without it the recorder never flushes that session's chain) and
   `coordinator:routing` phase=`routed` events if handoff edges are wanted in the record.
4. **Token counts must come from the summed per-call `models[]` breakdown** (already fixed in
   `squad-sdk/src/adapter/client.ts`) — never reintroduce the top-level pair, which describes
   only the last API call of a multi-call turn.
5. **Provider flakiness belongs in pre-registration**: m14 had to exclude `gemini-pro-latest`
   (quota errors on 8/10 runs; including it inflated the noise floor 14×). Exclusion rules are
   pre-registered, and exclusions print in the report.
6. **CI on `dev` is live** (`squad-ci.yml` triggers on push/PR to `dev` — verified 2026-08-07).
   On the S0 PR, confirm the full suite actually ran (not just "Scope Check") before merging.

---

## 4. Milestones

### S0 — Workspace package and the boundary test

**Deliverable:** `packages/duva-bench` scaffolded into the npm workspace: `package.json`,
`tsconfig`, vitest wiring, a CLI entry (`npx tsx packages/duva-bench/src/cli.ts --version`), any
missing `exports` entries added to squad-lab's `package.json`, and
`test/lab-duvabench-boundary.test.ts`: walks every import statement under
`packages/duva-bench/src` and fails on anything outside the §0.9 allowlist (with the
`src/arms/swarm.ts` exemption encoded).

**Done when:** `npm test` is green from a worktree including the boundary test; the boundary test
demonstrably fails when a forbidden import is temporarily added (show in the PR description);
full CI ran on the PR.

### S1 — The direct runner: a trial without the coordinator

**Deliverable:** `src/runner.ts` — runs one **trial** (task × arm × repetition) with no
`SquadCoordinator`:

1. Isolate: fresh clone via `isolate.ts`; register the arm's toolset (path-jailed).
2. `startAssignmentRecording({repoRoot, bus, externalRef, intentId, labels, onError})`.
3. Create the session via the arm's `SessionFactory` (squad-native or ai-sdk), send the brief
   (read back from the ADP issue, as run-variant does), await the turn.
4. Emit the terminal `session:destroyed`; call `recordCommit`/`recordTestResult` as applicable;
   `finishAssignmentRecording` closes the run against the final git sha (or abandons).
5. `verify` the run; persist a local `trial.json` (pointers + verdict only).

Both existing arms must run through it unchanged. Grading stays as in squad-lab (separate
identity, per-axis evals).

**Done when (GATE SG1 — hard stop):** one real trial per arm (cheapest model) produces an ADP
run with `/verify` `ok: true` and labels round-tripping through `runs/compare`;
`npm run harness-check` passes 8/8 for both arms driven by the new runner; the
direct-response-pattern test from §3.1 passes; unit tests cover abandon-on-failure and the
destroyed-flushes-chain behavior.

### S2 — Experiment spec, digest, pre-registration

**Deliverable:** `src/study.ts` — zod models: `TaskRef` (goal/seed/grader triple + grader
sha256), `ModelRef` (`provider[:tier][@model]`, reusing `variants.ts` parsing), `HarnessRef`
(`squad-native | ai-sdk`), `ToolsetRef` (named toolset + docs grade), `Topology`
(`single | swarm` — spec'd now, wired in S4), `Arm` (the refs + computed arm digest),
`PreRegistration` (primary metric, repetitions, exclusion rules, amendment list retaining
original values), `Study` (title, tasks, arms, reps, budget cap, concurrency, prereg). Canonical
digest matching the lab's existing canonicalization (the m5 check proved lab and ADP agree —
reuse that code path). CLI: `validate`, `digest`. Example: `examples/smoke-study.yaml` — 2 tasks
from `squad-lab/examples/` × 2 arms × 2 reps.

**Done when:** digest is proven stable under key reordering and sensitive to each field group
(parameterized test); the study digest and arm digest appear as run labels on an SG1-style trial.

### S3 — Twin toolsets and doc bundles (the Study A instrument)

**Deliverable:** `src/twins.ts` — deterministic generator: given a toolset and a seed, emit an
isomorphic twin (renamed tools/params — pronounceable, non-dictionary, length-matched names;
identical handlers), a persisted rename map, and doc bundles at grades `none` / `reference` /
`rich` (reference + worked examples), injected via the charter. Twin toolsets fold into
`harnessDigest` (tool names already do; ensure the docs-bundle digest is included).

**Done when:** a property-based test proves isomorphism (sampled inputs ⇒ identical outputs
between twin and original handlers); rename maps round-trip; each generated twin tool passes a
per-tool contract test (the `safePath`/`list_files` lesson — generate the contract test with the
twin); name-length matching asserted within stated tolerance.

### S4 — Factorial scheduler and topology arms

**Deliverable:** `src/scheduler.ts` generalizing `squad-lab/scripts/study.ts`:

- `planTrials(study)`: tasks × arms × reps, stable order, one ADP intent per task (idempotent by
  title convention `duva:<study_digest[:12]>:<task_id>`), `external_ref =
  <study_digest[:12]>:<arm_id>:<task_id>:r<n>`.
- Child process per trial (the four documented reasons: per-process keys/cwd, real SIGKILL,
  sibling isolation), bounded concurrency, budget checked before each trial via
  `CostTracker`/`pricing.ts`, append-only `progress.jsonl`, resumable: rerun skips trials whose
  `external_ref` already has a closed verified run.
- **Topology arm**: `src/arms/swarm.ts` — the only file allowed to import `SquadCoordinator` —
  runs a variant as coordinator + N charters (the precedented additive change: per-variant
  `agents`/`routing`, explicit variant ids since the auto-id can't express topology).
  `harnessDigest` already folds `agents`/`routing`, so topology arms get distinct digests —
  assert it.

**Done when:** a SIGKILL-mid-study test resumes with exactly the missing trials and no duplicate
ADP runs; the budget test proves no trial starts past the cap; a 2-arm smoke with
`single` vs `swarm` topology yields distinct harness digests and a banded (not blended) summary.

### S5 — Analysis, stats bridge, report

**Deliverable:** `src/analysis.ts` + `src/report.ts` —

- Outcomes from ADP only (per-intent `runs/compare`, `runs/{id}/stats`, trajectory reads):
  per-axis scores, tokens (summed-breakdown), cost, duration, tool calls/failures.
- Process metrics: tool-error rate, retries, **hallucinated-call rate** (tool_call names ∉ the
  arm's toolset — computable via the rename map), steps.
- Noise floor via `variance.ts` (pooled within-cell sd, contrasts in sd units); paired stats via
  the adp-replay Python bridge (§2) with Holm correction; everything seeded.
- Report: static HTML (visual style of the duva-bench docs page) + `report.json` — prereg echo
  with amendments, per-cell per-axis tables, CIs, noise-floor contrasts, digests, per-trial
  verify status, cost ledger, printed exclusion counts.

**Done when (GATE SG2 — hard stop):** the smoke study runs end to end (`run` → `report`) and a
test reconciles every reported number against direct ADP reads; an unscored trial renders
unscored; a run tampered with in the DB renders `ERROR` and is excluded from statistics with a
printed count; the same `outcomes.json` fed to the stats bridge twice gives identical output.

### S6 — Web UX

**Deliverable:** extend squad-lab's Fastify server + React SPA (or mount alongside them) with
three experiment-level views: **Define** (spec editor, validate/digest, prereg diff), **Monitor**
(trial grid via SSE with per-trial verify badges), **Analyze** (per-axis banded tables,
digest-mismatch warnings, cost/process columns, drill-down resolving runs via ADP
`external_ref`+labels, not local state only). Keep the six-literal-paths read-proxy stance — the
browser never holds an ADP token. Honor the SSE lessons already in the codebase: frame ids from
the file, subscribe-before-read, cache keyed by file path.

**Done when:** `npm run ui-check` (Playwright) walks define → run (smoke) → analyze; server
kill/restart mid-study loses no frames (`Last-Event-ID` resume test).

### S7 — Study A, squad track

**Deliverable:** `studies/a-tool-familiarity/` — **the same tasks and graders as the Harbor
track's M8**, arms standard / twin / twin+`reference` / twin+`rich` × ≥2 models × both in-process
harnesses, 5 reps, labels including `platform: squad`; pre-registration identical to the Harbor
track's (primary metric: hallucinated-call rate; metaprogramming recorded, not forbidden);
executed run; report committed with a written summary.

**Done when — GATE SG3, split 2026-08-08 into two gates.**

SG3 originally bundled this track's own completion with a cross-track comparison. That made a hard
gate depend on a precondition outside this track's control: the Harbor track is deliberately paused
(see "Track status" above), so no shared cells exist and none can be made here. A gate that cannot
be passed by doing good work is one that gets quietly ignored, and quietly ignoring a gate is how
pre-registration discipline dies. So the two questions are now two gates.

**SG3a — this track's own result. A hard stop, and passable on this track's evidence alone.**
The report prints the pre-registration unchanged or with explicit amendments; every included run
verifies; runs that do not verify are excluded and *counted*, never scored 0; and the write-up
states the noise floor before any contrast.

**SG3b — the cross-track memo. Deferred, with a stated precondition.**
Compares the familiarity effect squad-track vs. Harbor-track on the shared cells — same direction
and comparable magnitude, or a stated hypothesis for the divergence.

> **Precondition: the Harbor track reaching M8 with a shared task set.** Until then this gate is
> *deferred*, not failed and not waived. `studies/a-tool-familiarity-pilot/CROSS-TRACK.md` already
> registers the expected result in advance, so the memo cannot be fitted to the answer whenever the
> data does arrive. **Do not** substitute this track's own example tasks and present the result as
> a cross-track comparison; the pilot records that substitution explicitly rather than papering
> over it.

---

## 5. Deliberately excluded from this plan

Multi-turn quiescence (the m10 "biggest blocker" — post-S7, and only if the cross-track memo
shows this track earns it); subprocess/agent-CLI arms and containers (the Harbor track's job);
LLM-judge axes (blocked on ADP non-ranking evals); OpenAI/OpenRouter providers; upstream-sync
work on the fork.

---

## 6. Why run both tracks

The two tracks share tasks, graders, statistics, and the ADP record, and differ in exactly one
layer — bespoke in-fork execution vs. mature in-distribution execution. That is itself the
founding hypothesis applied to our own infrastructure. Concretely measurable by S7+M8: agent
build-velocity per milestone on each track, defect classes caught by each track's gates, and
whether the familiarity effect replicates across platforms. Whichever track wins, the loser's
run is still evidence.
