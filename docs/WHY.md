# Why this exists — the argument in plain text

The interactive version of this argument is at
[deduva.github.io/squad](https://deduva.github.io/squad). This page is the same
argument with no animation: who the work is for, what it claims, what it does
not claim, and what would prove it wrong.

## The environment it comes from

Some teams operate under rules that most developer tooling quietly assumes
away: air-gapped networks, regulated industries, code that must stay on
infrastructure the team itself operates. In those environments a tool welded to
a hosted cloud service doesn't degrade gracefully — it doesn't run.

This work began as an exploration of running AI agent teams in exactly that
kind of environment. Upstream [Squad](https://github.com/bradygaster/squad) is
a genuinely good team abstraction that runs only on GitHub Copilot; the first
job was making the team run where a cloud platform can't follow. Everything
else on the interactive page — the provider seam, the air-gapped install, the
record, the bench — followed from that constraint.

## The public facts

The claims below are limited to what GitHub's own public documentation says,
and each links to its source. If a linked page has changed since this was
written, the page wins.

- **Release cadence.** GitHub Enterprise Server ships as quarterly feature
  releases, and new features generally appear on GitHub.com before they appear
  in an Enterprise Server release.
  ([About GitHub Enterprise Server](https://docs.github.com/en/enterprise-server@latest/admin/overview/about-github-enterprise-server) ·
  [release notes](https://docs.github.com/en/enterprise-server/admin/release-notes))
- **Cloud connectivity.** Assistive features — GitHub Copilot among them —
  require GitHub Connect, a live connection from the self-managed install to
  GitHub's cloud. A fully offline install runs without the features that
  depend on GitHub's cloud services.
  ([GitHub Connect](https://docs.github.com/en/enterprise-server@latest/admin/configuration/configuring-github-connect/about-github-connect))
- **Pricing.** List pricing for the plans that include self-managed deployment
  is public at [github.com/pricing](https://github.com/pricing).

The neutral reading of all three: cloud software concentrates its newest
capabilities in the hosted cloud. That is the economics of shipping software,
not a criticism of any vendor — but it has a consequence.

## The problem

The consequence has two layers.

**The near-term layer.** The environments with the strictest requirements are
structurally last in line for the agent era. Agent tooling assumes cloud
connectivity; the newest capabilities land in the hosted products first; a team
behind an air gap watches the era happen from a release train.

**The deeper layer.** Even at perfect feature parity, the record a forge keeps
is insufficient for agent-produced change. A forge remembers that files
changed, who pushed, and a commit message someone typed. It has no field for
what a change was *for*, no proof the change was *verified against the state
that shipped*, and no record of *which model, harness, and session produced
it*. That was fine while humans wrote slowly and reviewed everything. It breaks
the day agents produce changes faster than anyone reads them.

## The thesis

1. The agent-era unit of record is not a diff. It is
   **intent → diff → evidence → provenance**, as one typed, signed record that
   a third party can verify with one call.
2. That record must be a property of the *record itself*, not of anyone's
   hosted service — deployable on a laptop, a CI runner, or behind an air gap,
   because the environments that need trust most are the ones the hosted cloud
   reaches last.

[ADP](https://deduva.github.io/adp/) is the protocol built to those two claims.

## What this is not

ADP is not a forge and not a replacement for one. GitHub — or GitLab, or any
forge — remains the system of record for code. ADP records the things forges
were never designed to record, alongside whichever forge the code lives in.
It is an open protocol under an open license, because a record only one party
can read is not evidence.

## The riskiest assumptions

Stated in the open, with what would falsify each:

1. **That demand exists.** Operators in constrained environments feel the pain
   described above strongly enough to adopt a protocol for it. *Falsified if:*
   sustained outreach produces no design partner and no second implementer.
2. **That forges won't simply absorb it.** *Falsified if:* a major forge ships
   intent/evidence/provenance binding with third-party verification. Worth
   saying plainly: that outcome would vindicate the thesis while ending the
   project's reason to exist — and it would still be a good outcome.
3. **That verifiability matters before an incident.** Trust infrastructure is
   often adopted after a failure, not before one. *Falsified if:* adoption
   interest only ever materializes retrospectively — in which case the wedge is
   compliance regimes, not developer experience, and the roadmap should say so.

## The evidence so far

- The fork runs end to end behind an air gap: zero runtime dependencies,
  single-file install, 6,880 tests passing on the decoupled tree.
- Every run closes into a signed, hash-chained ADP record; the recorder
  survives `kill -9` mid-run and `/verify` still answers — complete, or ERROR,
  never silently short.
- A pre-registered pilot ran 24 trials for $8.03, closed 24/24 verified, and
  reported an honest null, including that its own primary metric was the wrong
  bet. ([pre-registration, findings, report](https://github.com/DeDuva/squad/tree/dev/packages/duva-bench/studies/a-tool-familiarity-pilot))

What the evidence is not, yet: proof of demand. Assumption 1 is the open one,
and it is the next thing this work owes an answer to.

## License and attribution

The fork is MIT, © Brady Gaster and contributors (upstream). Fork by
Dov Zimring, with lots of help from Claude.
