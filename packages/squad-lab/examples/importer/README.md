# The CSV-importer task

A task built to **resolve a difference between models**, which the duration
example could not: its brief enumerated its own acceptance criteria, so a
competent implementation was a transcription and all three vendors scored 1.00.

Here nothing is enumerated. The seed is a working ~120-line CSV reader with a
passing test suite and three defects the suite does not catch, and the score
spreads across five axes rather than saturating two.

```bash
node packages/squad-lab/examples/importer/make-seed.mjs /tmp/importer-seed

npx tsx packages/squad-lab/src/cli.ts launch \
  --adp-url=http://127.0.0.1:8793 --owner=lab --repo=importer \
  --goal-file=packages/squad-lab/examples/importer/goal.md \
  --grader=packages/squad-lab/examples/importer/grader.mjs \
  --primary-axis=correctness \
  --seed=/tmp/importer-seed \
  --variants=anthropic:standard,anthropic:fast,gemini:standard
```

## What is wrong with the seed, and why each defect is there

| Defect | Unstated because |
|---|---|
| the final record is dropped when the document has no trailing newline | the shipped tests all end with one, so the suite is green and useless |
| `""` inside a quoted field is not read as a literal quote | the shipped tests never use an escaped quote |
| rows accumulate with `concat` in a loop, so parsing is quadratic | it is fast enough on the four-row tests and 25× too slow on twenty thousand |
| README says an empty field is `null`; the code returns `''` **and the consumers depend on `''`** | there is no right answer here — only a right behaviour |

## The five axes, and the tension between two of them

| Axis | Measures |
|---|---|
| `correctness` | ~20 hidden cases, weighted so the two unstated defects carry most of the score |
| `regression` | the three consumer programs still producing what they produced |
| `performance` | the benchmark, scored continuously — the axis that almost never ties |
| `ambiguity` | whether `NOTES.md` names the empty-field conflict *and* records a decision |
| `self-tests` | the repository's own suite |

**`correctness` and `regression` pull against each other on purpose.**
Following the README to the letter — making an empty field `null` — is more
correct by the documentation and breaks `report.js`, which interpolates the
value straight into its output. Measured:

| | correctness | regression | performance | ambiguity | self-tests |
|---|---|---|---|---|---|
| untouched seed | 0.52 | 1.00 | 0.00 | 0.00 | 1.00 |
| reference fix, keeping `''` | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| reference fix, following the README | 1.00 | **0.75** | 1.00 | 1.00 | 1.00 |

The instrument spans its whole range and the axes genuinely disagree, which is
what the duration task could not do. A run scores well on `ambiguity` whichever
side of the conflict it picks — what is measured is whether it *noticed* and
said so.

## Determinism

Every axis but `performance` is a pure function of the delivered tree.
`performance` is wall-clock and therefore noisy, so it is scored against
thresholds far apart (60 ms target, 200 ms floor, against a ~300 ms seed and a ~12 ms linear fix): what it
detects is an algorithmic difference, not a few milliseconds.

`ambiguity` is checked **structurally** — does the note exist, does it name both
readings, does it commit to one — and never by asking a model. `spec_digest`
identifies a rubric, and a rubric that returns different numbers on re-run makes
that digest a lie.
