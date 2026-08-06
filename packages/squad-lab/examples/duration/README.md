# The duration-parser slice

The example this package was proven on: a small, completely specified task,
scored on two axes that can disagree.

- `goal.md` — the brief. Filed as an ADP issue, which mints the intent every
  variant's run hangs off. The agents read it from there rather than from a copy
  someone hardcoded.
- `grader.mjs` — 19 hidden acceptance cases plus the repository's own
  `node --test`, reported as two independent axes.

The two axes measure genuinely different things, which is why they are never
blended:

- **acceptance** — does the delivered module behave as the brief specified?
  Outcome effectiveness, measured by cases the agents never saw.
- **self-tests** — does the repo's own suite pass? The agents wrote it. A run
  can implement the module perfectly and still ship a repository whose tests
  fail, because two agents each produced something defensible that does not fit
  together. That is deliverable coherence, and it is not a property of the
  module.

```bash
npx tsx packages/squad-lab/src/cli.ts launch \
  --adp-url=http://127.0.0.1:8793 --owner=lab --repo=duration \
  --goal-file=packages/squad-lab/examples/duration/goal.md \
  --grader=packages/squad-lab/examples/duration/grader.mjs \
  --seed=/path/to/an/empty/git/repo \
  --variants=anthropic:standard,anthropic:fast,gemini:standard
```

Any git repository with at least one commit works as the seed; the variant
clones it and repoints `origin` at ADP.
