"""Command-line entry point."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

import pydantic

from adp_replay import __version__
from adp_replay.context.g0 import run_probe
from adp_replay.context.registered import REGISTERED_PROVIDERS
from adp_replay.corpus import CorpusBelowTarget, build_corpus, discover_tasks
from adp_replay.corpus.terminal_bench import render_markdown as render_audit
from adp_replay.manifest import ManifestEnvelope, RunManifest
from adp_replay.stats.power import Assumptions, recommend_design, render_markdown, report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="adp-replay",
        description="Record agent trajectories and replay them under substituted models.",
    )
    parser.add_argument("--version", action="version", version=f"adp-replay {__version__}")

    sub = parser.add_subparsers(dest="command")
    sub.add_parser("record", help="Record a trajectory (Task 1.4)")
    sub.add_parser("replay", help="Replay under a substituted model (Tasks 2.1, 2.2)")
    sub.add_parser("report", help="Render reports from recorded runs (Task 3.2)")

    manifest = sub.add_parser("manifest", help="Inspect and verify run manifests (Task 0.1)")
    manifest_sub = manifest.add_subparsers(dest="manifest_command", required=True)

    digest = manifest_sub.add_parser("digest", help="Print a manifest's self-certifying digest")
    digest.add_argument("path", type=Path, help="A manifest or a manifest envelope, as JSON")

    verify = manifest_sub.add_parser("verify", help="Recompute an envelope's digest and compare")
    verify.add_argument("path", type=Path, help="A manifest envelope, as JSON")

    fidelity = sub.add_parser("fidelity", help="Run the context-fidelity probe and read G0")
    fidelity.add_argument(
        "--format", choices=("markdown", "json"), default="markdown", help="Report format"
    )
    fidelity.add_argument("--out", type=Path, help="Write the report here instead of stdout")
    fidelity.add_argument(
        "--providers",
        default=",".join(REGISTERED_PROVIDERS),
        help=(
            "Comma-separated provider scope. Narrowing below the registered floor is refused; "
            "any narrowing needs a logged amendment."
        ),
    )

    power = sub.add_parser("power", help="Recommend a corpus size (Task 0.4)")
    power.add_argument(
        "--format", choices=("markdown", "json"), default="markdown", help="Report format"
    )
    power.add_argument("--out", type=Path, help="Write the report here instead of stdout")
    power.add_argument("--target-power", type=float, default=0.8)
    power.add_argument("--effect-size", type=float, help="Detectable difference in success rate")
    power.add_argument("--base-rate", type=float, help="Success rate of the weaker model")
    power.add_argument("--between-task-sd", type=float, help="Task-difficulty spread, logit scale")

    audit = sub.add_parser("audit", help="Audit tasks for closure (Task 1.3)")
    audit.add_argument("root", type=Path, help="Directory holding Terminal Bench task folders")
    audit.add_argument(
        "--target-tasks",
        type=int,
        required=True,
        help="Task count the experiment needs, from `adp-replay power` (Task 0.4)",
    )
    audit.add_argument("--out", type=Path, help="Write tb2_closed_corpus.json here")
    audit.add_argument(
        "--allow-short",
        action="store_true",
        help="Write the corpus even when it falls short, for inspecting an audit in progress",
    )

    return parser


def _audit(args: argparse.Namespace) -> int:
    tasks = discover_tasks(args.root)
    if not tasks:
        print(f"no task directories under {args.root}", file=sys.stderr)
        return 2

    try:
        result = build_corpus(
            tasks,
            target_tasks=args.target_tasks,
            out=args.out,
            allow_short=args.allow_short,
            source=str(args.root),
        )
    except CorpusBelowTarget as short:
        # The summary is the useful artifact even when — especially when — the
        # corpus is not big enough, so it goes to stdout either way.
        print(render_audit(short.audit), end="")
        print(f"\n{short}", file=sys.stderr)
        return 1

    print(render_audit(result), end="")
    return 0


def _power(args: argparse.Namespace) -> int:
    assumptions = Assumptions()
    for name in ("base_rate", "effect_size", "between_task_sd"):
        value = getattr(args, name, None)
        if value is not None:
            assumptions = assumptions.replace(**{name: value})

    recommendation = recommend_design(target_power=args.target_power, assumptions=assumptions)
    rendered = (
        json.dumps(report(recommendation), indent=2) + "\n"
        if args.format == "json"
        else render_markdown(recommendation)
    )
    if args.out:
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


def _load(path: Path) -> RunManifest:
    """Read a manifest from either a bare manifest file or an envelope."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and "manifest" in payload:
        return ManifestEnvelope.model_validate(payload).manifest
    return RunManifest.model_validate(payload)


def _manifest_digest(path: Path) -> int:
    print(_load(path).digest)
    return 0


def _manifest_verify(path: Path) -> int:
    payload = json.loads(path.read_text(encoding="utf-8"))
    envelope = ManifestEnvelope.model_validate(payload)
    if envelope.verifies():
        print(f"ok {envelope.manifest_digest}")
        return 0
    # Print both, because the useful question after a failure is which of the
    # two moved — an edited manifest and a copied-in digest look identical from
    # a bare "mismatch".
    print(
        f"MISMATCH\n  recorded:   {envelope.manifest_digest}\n"
        f"  recomputed: {envelope.manifest.digest}",
        file=sys.stderr,
    )
    return 1


def _fidelity(args: argparse.Namespace) -> int:
    providers = tuple(p.strip() for p in str(args.providers).split(",") if p.strip())
    report = run_probe(providers=providers)

    rendered = (
        json.dumps(report.to_dict(), indent=2) + "\n"
        if args.format == "json"
        else report.to_markdown()
    )
    if args.out:
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")

    # A gate that exits 0 when it fails is not a gate. The failing cells go to
    # stderr so a CI log shows why without anyone opening the artifact.
    if report.passed:
        return 0
    for cell in report.failing:
        print(
            f"G0 FAIL {cell.pair} / {cell.capability.value}: "
            f"median {cell.median:.3f} < {report.threshold}",
            file=sys.stderr,
        )
    return 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    if args.command == "audit":
        try:
            return _audit(args)
        except (OSError, ValueError) as exc:
            print(f"{exc}", file=sys.stderr)
            return 2

    if args.command == "power":
        try:
            return _power(args)
        except (OSError, ValueError) as exc:
            print(f"{exc}", file=sys.stderr)
            return 2

    if args.command == "fidelity":
        try:
            return _fidelity(args)
        except (OSError, ValueError) as exc:
            print(f"{exc}", file=sys.stderr)
            return 2

    if args.command == "manifest":
        handler = {"digest": _manifest_digest, "verify": _manifest_verify}[args.manifest_command]
        try:
            return handler(args.path)
        except (OSError, json.JSONDecodeError, pydantic.ValidationError) as exc:
            print(f"{args.path}: {exc}", file=sys.stderr)
            return 2

    # Every remaining subcommand is a stub until its task lands. Exiting
    # non-zero keeps a scaffold from being mistaken for a working tool by a
    # script that only checks the exit code.
    parser.exit(2, f"'{args.command}' is not implemented yet — see docs/execution-plan.md\n")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
