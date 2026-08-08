# Cross-track memo — blocked, and why

PLAN.md's gate SG3 requires a memo comparing the familiarity effect on the
squad track against the Harbor track "on the shared cells — same direction and
comparable magnitude, or a stated hypothesis for the divergence."

**That comparison cannot be made yet, and this file exists so the gap is a
recorded fact rather than a quiet omission.**

## What is actually there

`github.com/DeDuva/duva-bench` — the Harbor track — is at its bootstrap commit:
README, licence, docs site, Pages workflow, and `docs/execution-plan.md`
describing M0–M8. There is no task set, no grader, no harness integration and no
executed run. M8 ("Study A, for real") has not been started.

So two of SG3's premises are unavailable:

1. **"the same tasks and graders as the Harbor track's M8."** Those tasks and
   graders do not exist. This pilot uses squad-lab's own example tasks
   (`retry`, `semver`) and their graders, which are *not* the shared set and are
   recorded here as a substitution rather than presented as one.
2. **"shared cells."** There are none. A cross-track contrast needs both tracks
   to have run the same cell, and only one track has run anything.

## What would make it possible

The Harbor track needs to reach M8 with a task set both tracks can consume — the
plan's shared contract is a `goal.md` + seed repo + `grader.mjs` triple, which
duva-bench already reads. When that exists:

- re-run this study against the shared task triples rather than squad-lab's examples;
- ensure both tracks label runs `platform: squad` / `platform: harbor` (this track already does, on every run);
- compare per-arm hallucinated-call rates on the cells both tracks ran, with the same seeded statistics — which both tracks already share via `adp_replay.stats.paired`, so a divergence cannot be a difference in method.

## The hypothesis, registered now

Recorded before any Harbor data exists, so it cannot be fitted to the answer.

**Expected: same direction, larger magnitude on the squad track.** The
familiarity effect should appear on both platforms, because it is a property of
the model rather than of the executor. It should be *larger* here, because this
track's agents get one turn: an in-process arm that reaches for a tool it does
not have has no second turn in which to notice and recover, while a Harbor arm
wrapping a real agent CLI is a long-horizon loop that can. If that is right, the
squad track over-reads the effect and the Harbor track is the better estimate of
its size — which would itself be a useful finding about the pair of tracks.

**A divergence in direction would be the interesting outcome**, and the first
thing to check would be whether the twin generator's names collide differently
with each platform's own tool vocabulary.

## Status

**Study digest:** `445a362ab923994113407b9fc9911e3a03cd7112c5d3ecbe85d3c239bc06bff3`

SG3 clauses:

| clause | status |
|---|---|
| the report prints the pre-registration unchanged or with explicit amendments | met |
| every included run verifies | met |
| the write-up states the noise floor before any contrast | met |
| cross-track memo comparing squad vs Harbor on shared cells | **blocked — no Harbor data exists** |

This pilot does not claim SG3. It claims three of its four clauses and names the
fourth as outstanding.
