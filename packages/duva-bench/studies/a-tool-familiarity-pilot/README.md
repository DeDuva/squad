# tool familiarity — pilot

A reduced-scale run of the Study A design: four arms differing only in what the
agent knows about its tools, on squad-lab's `retry` and `semver` example tasks.

**This is not Study A.** Study A is four arms × at least two models × both
in-process harnesses × five repetitions. This is one model, one harness, three
repetitions — 24 trials — registered as a deliberate reduction before execution.

Read in this order:

| file | what it is |
|---|---|
| `PREREGISTRATION.md` | what was decided before anything ran |
| `FINDINGS.md` | the write-up, noise floor first |
| `CROSS-TRACK.md` | why gate SG3's Harbor comparison is blocked |
| `study.yaml` | the machine-readable spec (digested) |
| `report/` | `report.json`, `report.html`, `outcomes.json` as generated |

## Reproducing it

Seeds are materialised rather than committed — a trial clones its seed, so the
seed must be a real repository, and a repository cannot usefully nest inside
another one:

```bash
node prepare-seeds.mjs

export SQUAD_LAB_ADP_TOKEN=…   # the runner identity
export SQUAD_LAB_EVAL_TOKEN=…  # the grader identity, which must differ

npx tsx packages/duva-bench/src/cli.ts study \
  --file=packages/duva-bench/studies/a-tool-familiarity-pilot/study.yaml \
  --adp-url=http://127.0.0.1:8793 --owner=duvabench --repo=pilot --root=/tmp/pilot

npx tsx packages/duva-bench/src/cli.ts report \
  --file=packages/duva-bench/studies/a-tool-familiarity-pilot/study.yaml \
  --adp-url=http://127.0.0.1:8793 --owner=duvabench --repo=pilot \
  --baseline=standard --out=packages/duva-bench/studies/a-tool-familiarity-pilot/report
```

The study is resumable: rerunning skips any trial that already has a closed,
verified **and graded** run, so an interrupted study costs only the trials it
lost.

Paths in `study.yaml` are relative on purpose. A task's paths and its grader's
sha256 are all in the study digest, so absolute paths would make the digest
machine-specific and orphan the study's intents on any other checkout.
