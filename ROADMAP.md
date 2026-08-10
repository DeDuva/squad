# squad (DeDuva fork) — Roadmap

**This file is the repo's only status ledger.** A PR that completes, starts, pauses, or
supersedes a milestone updates this file in the same PR. Scope authority for the bench
track is [`packages/duva-bench/PLAN.md`](packages/duva-bench/PLAN.md) — this file says
where things are, not how the next piece gets built.

## Mission

A fork of `bradygaster/squad` replatformed to be model- and harness-agnostic, hosting
two research packages: **squad-lab** (goal-setting and cross-provider A/B experiments —
one ADP intent, N verified runs) and **duva-bench's squad track** (in-process factorial
experiments over coding-agent arms, twin toolsets, pre-registered statistics).

## Where this fits

squad and ADP are each other's test fixture: squad wraps the `gh` CLI, ADP's locked
success criterion is that unmodified `gh` works against it, so squad runs against ADP
with zero code changes. Statistics come from adp-replay's `adp_replay.stats.paired`,
pinned by commit. The Harbor track of duva-bench lives at `github.com/DeDuva/duva-bench`.
The dependency map is ADP's `docs/ecosystem.md`; milestone reports and the portfolio
audit live in the private `github.com/DeDuva/duva-lab-tpm`.

## Milestone ledger

### The fork itself

| Item | Status | Evidence / detail |
|---|---|---|
| Replatform (model/harness-agnostic) | complete 2026-08-07 | The `replatform-0.11` line is spent; `dev` was made default at its tip. PRs #74–#89 carry the lab work |
| Upstream sync | paused | Decision **DEFER**, taken against a stated rubric (duva-lab-tpm `reports/m1-upstream-sync-decision.md`). Resume condition: the rubric's terms change |

### squad-lab (`packages/squad-lab`)

| Item | Status | Evidence / detail |
|---|---|---|
| M0–M14 | complete | Fifteen milestone reports in duva-lab-tpm `reports/` — through the 80-run, ~$28 variance study (M14). ⚠️ M12's token figures are known wrong and annotated there |
| Next scope (M15) | not started — awaiting a decision | squad-lab is **active, not complete** (author, 2026-08-08). duva-lab-tpm `reports/m15-next-scope-proposal.md` collects every forward ask, marks four as shipped, and puts three options with a recommendation. It is a proposal, not a plan of record |

### duva-bench, squad track (`packages/duva-bench`)

| Item | Status | Evidence / detail |
|---|---|---|
| S0–S7 | complete 2026-08-08 | One PR per milestone into `dev`. Gates **SG1** and **SG2** passed. S7 ran a live 24-trial pilot: $8.03, 24/24 runs verified, pre-registration printed unchanged |
| Gate SG3a (this track's own result) | passed 2026-08-08 | `studies/a-tool-familiarity-pilot/FINDINGS.md` — noise floor stated before any contrast, every included run verified |
| Study A proper | not started — awaiting a decision | The pilot's real finding: the pre-registered primary metric (`hallucinatedCallRate`) has a **floor effect** — 0.0000 on all 24 trials in every arm. Study A needs a **re-registered** metric, not an amendment; no design is written yet |
| Gate SG3b (cross-track memo) | paused | Precondition: the Harbor track reaching M8 with a shared task set. Harbor's own pause was **lifted 2026-08-08** (an end-to-end probe ran there), so this is now a matter of that track doing the work. The expected result is registered in advance in `studies/a-tool-familiarity-pilot/CROSS-TRACK.md` |

## Now / Next / Later

- **Now:** nothing in flight.
- **Next:** two author decisions unblock everything queued here — squad-lab's M15
  option, and Study A's replacement metric (then a new pre-registration and a
  pilot-scale re-run before committing to the full study).
- **Later:** SG3b when the Harbor track reaches M8; multi-turn quiescence only if the
  cross-track memo shows this track earns it (PLAN.md §5).

## Blockers and open decisions

- **squad-lab M15 — decision needed (author):** pick among the three options in
  `m15-next-scope-proposal.md`, or decline them all. Proposal dated 2026-08-08.
- **Study A primary metric — decision needed (author):** the three candidate designs
  are named in the pilot's FINDINGS (larger tool surface; tools withheld from the
  schema; tasks requiring an absent tool). Re-running at pilot scale costs real money
  (calibration: $8.03 for 24 trials).
- **No blockers otherwise.** Verified 2026-08-08: keys, statistics venv, and the ADP
  stack all work; the statistics path is CI-run and commit-pinned (PR #104).

## Plan documents

- [`packages/duva-bench/PLAN.md`](packages/duva-bench/PLAN.md) — the squad track's plan
  of record: agent rules (§0, including the import boundary), the reuse map (§2),
  milestones S0–S7 with gates.
- `packages/duva-bench/studies/a-tool-familiarity-pilot/` — the executed pilot:
  pre-registration, findings, cross-track registration.
- duva-lab-tpm (private) — squad-lab's milestone reports M0–M14, the M15 proposal, and
  the portfolio audit.
