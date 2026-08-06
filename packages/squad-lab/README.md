# squad-lab

Run one goal across several model providers, and compare the results as
evidence rather than as impressions.

An A/B test here is **one ADP intent and N ADP runs**. That framing is the whole
design: ADP already records each run's trajectory, attests it, and ranks the set
(`GET /runs/compare?intent_id=`), so the lab stores nothing ADP can answer — no
scores, no token counts, no comparison table. It holds forward pointers, live
process state, and the raw event log, and nothing else.

## What it gives you

- **One goal, N vendors.** Each variant runs in its own process, on its own
  clone, against the same ADP intent.
- **Scores from a second identity.** A grader you write reports each named axis
  as its own ADP eval. `separately_authorized` compares identities, so a run
  cannot score itself.
- **A summary that refuses to blend.** One column per axis, ranked
  independently — no mean, no weighted score, no "overall".
- **A live board and a drill-down**, from the goal all the way to the run's own
  `verify` result.

## Running it

You need an ADP server and **two ADP identities** — one that opens runs, one
that reports scores.

```bash
# in an ADP checkout
make up && npm run migrate --prefix server
PORT=8793 npm run dev --prefix server &
npx tsx server/src/bootstrap.ts squad-lab-runner   # → SQUAD_LAB_ADP_TOKEN
npx tsx server/src/bootstrap.ts squad-lab-grader   # → SQUAD_LAB_EVAL_TOKEN
```

```bash
export SQUAD_LAB_ADP_TOKEN=… SQUAD_LAB_EVAL_TOKEN=…
npm run build -w @deduvafork/squad-sdk
npm run web:build -w @deduvafork/squad-lab      # only needed for the UI

# as a server, with the UI on http://127.0.0.1:7317/app/
npx tsx packages/squad-lab/src/cli.ts serve --adp-url=http://127.0.0.1:8793

# or headless, straight from the command line
npx tsx packages/squad-lab/src/cli.ts launch \
  --adp-url=http://127.0.0.1:8793 --owner=lab --repo=duration \
  --goal-file=packages/squad-lab/examples/duration/goal.md \
  --seed=/path/to/a/git/repo \
  --grader=packages/squad-lab/examples/duration/grader.mjs \
  --variants=anthropic:standard,anthropic:fast,gemini:standard
```

Commands: `serve`, `launch`, `run-variant`, `regrade`, `summary`, `list`.

**Credentials are asymmetric.** Anthropic inherits the `claude` CLI's own
credential chain, so there is nothing to pass. Gemini needs its key explicitly,
from `GEMINI_API_KEY` or `~/.config/squad/gemini.json` — and `GEMINI_API_KEY`
merely being set deliberately does not select that vendor.

## Writing a grader

`node <grader> <workRepo>` prints JSON on stdout and exits 0. Each named axis
becomes its own ADP eval. See `examples/duration/grader.mjs`.

```jsonc
{ "spec": { "suite": "duration-acceptance", "cases": 19 },
  "axes": {
    "acceptance": { "score": 1.0, "passed": true, "summary": "19/19",
                    "metrics": { "passed": 19, "total": 19 } },
    "self-tests": { "score": 0.0, "passed": false, "summary": "repo suite failed" } } }
```

- `score` is `0..1`, or `null` for "did not apply" — reported as an eval with no
  score rather than omitted, because a missing axis and a failed axis are
  otherwise the same blank cell.
- A grader that exits non-zero or prints unparsable output leaves the variant
  **unscored, not zero**.
- The lab injects the grader file's sha256 into the spec, so editing the grader
  mid-experiment changes the `spec_digest` and the summary says the columns are
  not comparable instead of silently ranking across two rubrics.
- Exactly one axis (`--primary-axis`) reports under the gate name `score`.

The grader runs with its working directory **outside** the work repo and with
every ADP token stripped from its environment. It is a hidden suite only for as
long as it stays outside the tree the agents were given, and it measures rather
than reports.

## Checks that cost nothing

Three live checks run the whole thing against a real ADP without invoking a
model, so the plumbing can be verified without spending:

```bash
npm run grade-check  -w @deduvafork/squad-lab   # two identities, axes, digests
npm run stream-check -w @deduvafork/squad-lab   # SSE replay, proxy, cancel
npm run ui-check     -w @deduvafork/squad-lab   # the SPA, in a real browser
```

## Layout

```
src/server.ts      Fastify: experiments, SSE, the ADP read proxy, the SPA
src/experiments.ts create / launch / cancel / regrade, and the file store
src/run-variant.ts one goal, one vendor, one recorded ADP run
src/grader.ts      invoke, parse, digest, report one eval per axis
src/event-log.ts   the SSE frame log, numbered off the file so replay survives
src/isolate.ts     a fresh clone per variant
web/               the SPA — board, exec summary, drill-down, verify
```
