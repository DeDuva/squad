# Tasks and graders

Each directory is one assignment: a `goal.md` the agents read from the ADP
issue, a `grader.mjs` they never see, and a `seed/` that `make-seed.mjs` turns
into the git repository a variant clones.

## The grader contract

`node grader.mjs <work-repo>` prints one JSON object on stdout:

```json
{ "spec": { … }, "axes": { "<name>": { "score": 0.87, "passed": false, "summary": "…", "metrics": { … } } } }
```

`spec` is digested by the lab and posted to ADP as `spec_digest`, so two runs
scored under different rubrics are visibly incomparable rather than quietly
ranked together. A `score` of `null` means *not measured* and is never rendered
as zero.

## The axes, and why there are four

The study tasks report the same four, because a single number hides the thing
worth knowing:

- **`acceptance`** — the whole hidden suite, as a pass rate.
- **`edge-cases`** — the adversarial subset only. A run can score well on
  `acceptance` by getting the common shapes right; this is the axis that says
  so. In every negative control below it lands *lower* than `acceptance`, which
  is what makes it worth reporting separately.
- **`api-shape`** — does the export exist, is it callable, does it return the
  documented type, does it survive garbage input? Separated because a module
  that throws on `null` scores zero on everything for one reason, and a reader
  should see which reason.
- **`self-tests`** — the repository's own suite, which the agents wrote. A run
  can implement the module perfectly and still ship a repo whose tests fail.

## Validating a grader before it scores anything

A grader with a bug produces plausible numbers and poisons every run scored
under it. Each of these was checked twice before use — against a **correct**
reference implementation, which must score `1.00`, and against a **naive but
plausible** one, which must score below it *and* lose more on `edge-cases` than
on `acceptance`:

| task | naive `acceptance` | naive `edge-cases` | what the naive version got wrong |
|---|---|---|---|
| `csvparse` | 0.53 | 0.27 | split on newlines and commas, ignoring quoting |
| `retry` | 0.65 | 0.42 | no `maxDelayMs` clamp, no abort handling, no `shouldRetry` |
| `ledger` | 0.89 | 0.75 | summed dollars as floats and converted to cents at the end |
| `semver` | 0.85 | 0.72 | lexical prerelease compare, caret always bumping major, no prerelease exclusion |

`ledger` is the clearest case for keeping the two axes apart: the float bug
costs it 0.11 on `acceptance` and 0.25 on `edge-cases`, because the subset was
built to contain exactly the accumulations that expose it.

## Difficulty

`duration` and `csvparse` **saturate** — a current model writes a correct
implementation first try, and a suite everything scores 1.00 on measures
nothing. They are kept because saturation is a useful control, but a study that
wants score variance should use `semver` (prerelease precedence, caret on a
zero major, prerelease exclusion from ranges) or `retry` (abort during a
backoff wait), whose negative controls spread furthest.
