# Pre-registration — tool familiarity (pilot)

Registered before execution. `study.yaml` carries the machine-readable copy;
this is the same content in prose, and the report prints it back unchanged or
with amendments beside the reading they replaced.

**Study digest at registration:** `445a362ab923994113407b9fc9911e3a03cd7112c5d3ecbe85d3c239bc06bff3`

## What is being asked

Do agents use an unfamiliar toolset worse than an equally capable familiar one,
and does documentation buy the difference back?

Capability is held exactly fixed: the twin arms run *the same handlers* as the
control under renamed tools, so the only thing that varies is vocabulary and how
much the agent is told about it.

## This is a pilot, not Study A

Study A is four arms × at least two models × both in-process harnesses × five
repetitions. This is four arms × **one** model × **one** harness × **three**
repetitions, on two tasks — 24 trials.

The reduction is registered here as a deliberate scope decision made *before*
execution, not as a study that turned out smaller than hoped. A pilot at this
size can show that the instrument works end to end on real data and can surface
execution problems cheaply. It cannot support a claim about familiarity, and the
write-up must not make one.

## Primary metric

**`hallucinatedCallRate`** — the share of a trial's tool calls naming a tool
that is not on that arm's surface, judged against the arm's own names so a twin
arm is scored on the same footing as its control.

Chosen before execution over `acceptance` because acceptance is a coarse
pass/fail on toy tasks and is expected to saturate; the hallucinated-call rate
measures the thing the hypothesis is actually about.

Metaprogramming is **recorded, not forbidden**. An agent that inspects its own
tool surface is doing something real and interesting, and a rule against it
would be unenforceable and would silently change what is being measured.

## Secondary metrics

`acceptance`, `toolFailures`, `steps`.

## Exclusions, decided in advance

- **`unverified-run`** — any trial whose ADP `/verify` is not `ok`. Such a run is an `ERROR`, never a zero, and errors count against the majority.
- **`provider-quota`** — any trial ending in a provider quota or rate-limit error. m14 lost 8 of 10 runs on one model that way, and including them inflated the pooled noise floor 14×.

Exclusion counts are printed in the report whether or not any fired.

## Analysis, decided in advance

- The **noise floor** is reported before any contrast. A difference smaller than the pooled within-cell spread is not a finding, whatever its sign.
- Paired statistics resample over **tasks**, never over trials, with Holm correction across arms. Seeded, so the same outcomes give the same answer.
- Scores are reported **per axis**. There is no blended score, and no arm is ranked on one.

## Amendments

None. Any amendment must record the value it replaced, so the reading as
registered stays computable.
