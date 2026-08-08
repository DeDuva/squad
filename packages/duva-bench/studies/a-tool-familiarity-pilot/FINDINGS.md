# Findings — tool familiarity (pilot v2)

**Study digest:** `445a362ab923994113407b9fc9911e3a03cd7112c5d3ecbe85d3c239bc06bff3`
**24 trials, 24 included, 0 excluded.** Every run closed and passed ADP `/verify`.
Cost $8.03, none unpriced. Pre-registration printed unchanged; no amendments.

## The noise floor, before any contrast

| axis | pooled within-cell sd | cells |
|---|---|---|
| `acceptance` | 0.0216 | 8 |
| `api-shape` | 0.0000 | 8 |
| `edge-cases` | 0.0296 | 8 |
| `self-tests` | 0.3536 | 8 |

`self-tests` has a noise floor an order of magnitude larger than the others.
Nothing on that axis is worth reading at this scale, and it is not read below.

## The primary metric did not discriminate. That is the finding.

`hallucinatedCallRate` was **0.0000 on all 24 trials, in every arm, with zero
variance and not one invented tool name** — including the six trials of
`twin-none`, where the agent was given four tools with nonsense names, no
descriptions, and no documentation beyond a JSON schema.

| arm | n | hallucinated-call rate |
|---|---|---|
| `standard` | 6 | 0.0000 |
| `twin-none` | 6 | 0.0000 |
| `twin-reference` | 6 | 0.0000 |
| `twin-rich` | 6 | 0.0000 |

The metric has a floor effect on this instrument. With a four-tool surface
presented as a schema on every call, the model has no occasion to invent a name:
the tools are in front of it, and it uses them. Pre-registering
`hallucinatedCallRate` as the primary metric was a reasonable bet and it was
wrong, which is the single most useful thing this pilot produced — finding it
here cost $8 and an hour rather than being discovered inside Study A.

**Implication for Study A:** either the metric changes, or the instrument must
be able to produce the behaviour it measures. A larger tool surface, tools
withheld from the schema and named only in prose, or tasks that need a tool the
arm does not have would all give the metric room to move. That is a design
decision to make before Study A, and it should be re-registered, not amended
mid-flight.

## Secondary: acceptance

Direction is consistent with the hypothesis and the evidence is far too weak to
say so. Reported because it was pre-registered, not because it shows anything.

Per-arm pass rate (the grader's own binary verdict), paired over two tasks,
baseline `standard`:

| arm | rate | 95% CI | contrast vs standard | p | p (Holm) |
|---|---|---|---|---|---|
| `standard` | 0.667 | 0.333 – 1.000 | — | — | — |
| `twin-none` | 0.167 | 0.000 – 0.333 | −0.500 | 0.375 | 1.000 |
| `twin-reference` | 0.500 | 0.333 – 0.667 | −0.167 | 1.000 | 1.000 |
| `twin-rich` | 0.500 | 0.333 – 0.667 | −0.167 | 1.000 | 1.000 |

The ordering is the one the hypothesis predicts — the undocumented twin is
worst, documentation recovers part of the gap — and **nothing here survives
correction**. With two tasks and three repetitions the design cannot resolve a
half-point difference; every Holm-corrected p is 1.000, and the CIs all cross
zero. ICC on the baseline is 0.5, meaning half the variance sits between the two
tasks: two tasks is not a corpus.

On the continuous `acceptance` score the cell means run 0.950 – 1.000 against a
noise floor of 0.0216, so the largest gap is roughly two standard deviations —
directionally the same story, on an axis close to saturated.

## Process metrics

| arm | mean steps | mean tool failures |
|---|---|---|
| `standard` | 15.0 | 2.17 |
| `twin-none` | 9.5 | 3.33 |
| `twin-reference` | 19.8 | 3.33 |
| `twin-rich` | 11.2 | 1.50 |

The undocumented twin took the *fewest* steps and failed most often — it gave up
earlier rather than exploring harder. Suggestive, unsupported, and worth
instrumenting deliberately in Study A rather than reading off a pilot.

## What this pilot does not claim

It does not claim a familiarity effect exists, does not claim documentation
recovers one, and is not Study A. It is one model, one harness, two tasks and
three repetitions: enough to prove the instrument runs end to end on real data,
and not enough to support a claim about agents.

## What it proved about the instrument

- Twins are isomorphic in practice: agents completed real tasks using only twin names, and produced working code with tests.
- Grading, per-axis evals, the noise floor, the seeded paired statistics and the report all work on live data.
- Every trial verified. The evidence gate never had to fire, and the exclusion counts printed as zero rather than being omitted.

It also found three execution bugs that only a real run could surface — a stale
work directory defeating resumption, relative task paths resolved against the
wrong directory in forked children, and a trial that could be closed and
verified yet never graded, which resumption then skipped forever. All three are
fixed and carry regression tests.
