"""Manifest models (Task 0.1) and state-completeness levels (Task 0.2).

A manifest is the record of one recorded or replayed run: the environment it ran
in, the model that drove it, the tools it could reach, the steps it took, and the
verdict it earned. It is the unit a published artifact ships, so every field here
is something a reader who was not present needs in order to know what the numbers
mean.

Two properties are structural rather than conventional:

* :class:`StateCompleteness` has no default. A manifest that does not say what
  its snapshots captured cannot be constructed at all (Task 0.2), because the
  likely failure is not a wrong declaration but a missing one.
* The digest excludes storage identifiers (:mod:`adp_replay.manifest.digest`),
  so a manifest verifies away from the store that held it.

Models are frozen and reject unknown fields. Frozen because a manifest whose
digest was printed and then mutated is a lie in flight; ``extra="forbid"``
because a typo'd field name in a hand-written manifest should be an error, not a
silently dropped declaration.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from adp_replay.manifest.digest import canonical_form, digest_payload
from adp_replay.verdict.gating import Verdict

# Bumped when a change would make an older reader misread a newer manifest.
# Additive optional fields do not bump it; a changed meaning always does.
SCHEMA_VERSION = "0.1.0"

# ADP prefixes content digests this way and so do we, so a digest read out of a
# manifest can be compared to one read out of ADP without unwrapping either.
Sha256Digest = Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]
GitSha = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]


class StateCompleteness(StrEnum):
    """What a snapshot actually captured.

    v0 supports FILESYSTEM only. Processes, sockets, and kernel state are out of
    scope and must be declared as such rather than left unsaid — a reader of a
    published artifact has no other way to know what the replay did not restore.

    Adding a level here is not a local change: the manifest, the report header,
    and the limitations section all reprint it, and a level that exists in the
    enum but is not restored by the replayer overstates what was reproduced.
    """

    FILESYSTEM = "filesystem"


class ReplayMode(StrEnum):
    """How this run was produced.

    The distinction is load-bearing rather than descriptive. ``FORK_AT_ZERO`` is
    a model comparison; ``FORK_AT_STEP`` measures continuation under a foreign
    policy prefix and is never presented as one. Recording it in the manifest is
    what lets a report decide, from the artifact alone, whether the continuation
    banner must appear.
    """

    RECORDING = "recording"
    FORK_AT_ZERO = "fork_at_zero"
    FORK_AT_STEP = "fork_at_step"


class StepKind(StrEnum):
    """Mirrors ADP's event kinds, so a step maps to an event without a lookup."""

    MESSAGE = "message"
    MODEL_CALL = "model_call"
    TOOL_CALL = "tool_call"
    HANDOFF = "handoff"
    COMMIT = "commit"
    TEST_RESULT = "test_result"
    CUSTOM = "custom"


class StepStatus(StrEnum):
    """Mirrors ADP's event statuses."""

    SUCCESS = "success"
    FAILURE = "failure"
    ERROR = "error"
    REJECTED = "rejected"
    SKIPPED = "skipped"


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class EnvironmentSpec(_Frozen):
    """The closed world the run executed in.

    Pinned by image *digest*, not tag: a tag is a mutable pointer, and a corpus
    re-run six weeks later against a moved tag is a different experiment wearing
    the same name.
    """

    image: str
    image_digest: Sha256Digest
    platform: str = "linux/amd64"
    harness: str
    harness_version: str
    # Anything else that pins the environment and is not covered above — kernel
    # version, locale, a base commit. Digested with the rest.
    attributes: dict[str, JsonValue] = Field(default_factory=dict)


class ModelSpec(_Frozen):
    """The model under test, and the parameters it was driven with.

    Sampling parameters are part of the identity of a result. Two runs of the
    same model at different temperatures are not repetitions of one condition.
    """

    provider: str
    model: str
    parameters: dict[str, JsonValue] = Field(default_factory=dict)


class ToolSpec(_Frozen):
    """One tool the agent could call.

    ``definition_digest`` covers the schema the model was shown. A tool whose
    description changed between conditions changes the policy the model is
    running, which is exactly the confound a pinned harness exists to exclude.
    """

    name: str
    definition_digest: Sha256Digest


class StepRecord(_Frozen):
    """One step of the trajectory, as recorded.

    Payloads live in ADP and in the content-addressed store; the manifest keeps
    their digests. That keeps a manifest small enough to read and to publish
    while still committing to exactly what happened.
    """

    producer_seq: int = Field(ge=1)
    kind: StepKind
    client_event_id: str
    payload_digest: Sha256Digest
    status: StepStatus | None = None
    model: str | None = None
    tokens_in: int | None = Field(default=None, ge=0)
    tokens_out: int | None = Field(default=None, ge=0)
    cost_micro_usd: int | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
    git_sha: GitSha | None = None
    # CAS digests of the filesystem snapshots bracketing this step (Task 1.2).
    # Absent on steps that cannot change the filesystem.
    pre_state_digest: Sha256Digest | None = None
    post_state_digest: Sha256Digest | None = None
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def _utc(cls, value: datetime) -> datetime:
        return _require_utc(value, "occurred_at")


class AdpBinding(_Frozen):
    """Where this run was recorded to ADP, and what ADP attests about it.

    ``trajectory_digest`` is ADP's, copied — not recomputed here. A second,
    independently derived chain digest would be a second opinion about the same
    events, and the one the run attestation is signed over is the one that
    matters; recomputing invites the two to disagree and the disagreement to be
    resolved in favour of whichever is more convenient.
    """

    base_url: str
    owner: str
    repo: str
    run_id: str
    session_ids: tuple[str, ...] = ()
    trajectory_digest: str | None = None
    final_git_sha: GitSha | None = None


class VerdictRecord(_Frozen):
    """A scored outcome, together with what makes it admissible.

    ``scorer_spec_digest`` is ADP's ``spec_digest`` on the eval — the identity of
    the scorer. Results carrying different scorer digests are not comparable
    (Task 2.1). ``separately_authorized`` is ADP's answer to whether the identity
    that reported the score is the one that did the work; a false here means the
    score is a self-report, however good it looks.
    """

    name: str
    verdict: Verdict
    score: float | None = None
    scorer_spec_digest: str | None = None
    separately_authorized: bool | None = None
    # Which sub-checks of ADP's verify response forced a downgrade to ERROR.
    # Empty on a verdict that was not downgraded (Task 3.3).
    downgraded_because: tuple[str, ...] = ()

    @model_validator(mode="after")
    def _error_is_explained(self) -> Self:
        # An ERROR with no reason is indistinguishable from a bug in the gater,
        # and the point of the downgrade is that it stays diagnosable.
        if self.verdict is Verdict.ERROR and not self.downgraded_because:
            raise ValueError("an ERROR verdict must record which check failed")
        return self


class RunManifest(_Frozen):
    """The record of one run: what ran, under what, doing what, to what end."""

    schema_version: str = SCHEMA_VERSION
    # Excluded from the digest — see adp_replay.manifest.digest.
    run_id: str
    task_id: str
    recorded_at: datetime
    mode: ReplayMode
    # No default, deliberately (Task 0.2).
    state_completeness: StateCompleteness
    environment: EnvironmentSpec
    model: ModelSpec
    tools: tuple[ToolSpec, ...] = ()
    steps: tuple[StepRecord, ...] = ()
    verdicts: tuple[VerdictRecord, ...] = ()
    adp: AdpBinding | None = None
    # Set on fork-at-step only, and required there: a continuation diagnostic
    # that does not say where it continued from cannot be interpreted.
    forked_from_step: int | None = Field(default=None, ge=1)
    # The manifest this run was forked from, when it was forked from one.
    forked_from_manifest_digest: str | None = None
    # Median context fidelity for the provider pair this run used (Task 0.3b).
    # Reprinted in every report header, never in an appendix.
    context_fidelity: float | None = Field(default=None, ge=0.0, le=1.0)
    notes: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("recorded_at")
    @classmethod
    def _utc(cls, value: datetime) -> datetime:
        return _require_utc(value, "recorded_at")

    @field_validator("steps")
    @classmethod
    def _contiguous(cls, steps: tuple[StepRecord, ...]) -> tuple[StepRecord, ...]:
        # The recorder's whole resume protocol exists to produce a gap-free
        # chain (Task 1.4). A manifest that accepted a gap would let the one
        # artifact a reader checks disagree with the guarantee ADP verified.
        for index, step in enumerate(steps, start=1):
            if step.producer_seq != index:
                raise ValueError(
                    f"steps must be contiguous from 1: expected producer_seq={index}, "
                    f"got {step.producer_seq}"
                )
        return steps

    @model_validator(mode="after")
    def _fork_step_is_declared(self) -> Self:
        if self.mode is ReplayMode.FORK_AT_STEP and self.forked_from_step is None:
            raise ValueError("fork_at_step requires forked_from_step")
        if self.mode is not ReplayMode.FORK_AT_STEP and self.forked_from_step is not None:
            raise ValueError(f"forked_from_step is meaningless for mode={self.mode}")
        return self

    @property
    def digest(self) -> str:
        """This manifest's self-certifying digest.

        A property rather than a field: a stored digest can disagree with its
        own contents, and a manifest carrying a stale digest is worse than one
        carrying none. Publish it alongside, via :meth:`ManifestEnvelope.of`.
        """
        return digest_payload(self.model_dump(mode="json"))

    def canonical(self) -> dict[str, Any]:
        """The exact structure the digest is taken over — for inspection."""
        return canonical_form(self.model_dump(mode="json"))


class ManifestEnvelope(_Frozen):
    """A manifest published beside its digest.

    Beside rather than inside, so verification is a recomputation over the inner
    object rather than a comparison of a field with itself.
    """

    envelope_version: Literal["1"] = "1"
    manifest_digest: str
    manifest: RunManifest

    @classmethod
    def of(cls, manifest: RunManifest) -> ManifestEnvelope:
        return cls(manifest_digest=manifest.digest, manifest=manifest)

    def verifies(self) -> bool:
        return self.manifest.digest == self.manifest_digest


def _require_utc(value: datetime, field: str) -> datetime:
    # A naive datetime and an aware one reading the same wall clock digest
    # differently, so "when did this run" would silently depend on the recording
    # machine's timezone. Rejecting naive input is the only way to keep the
    # digest a function of the instant rather than of the recorder's locale.
    if value.tzinfo is None:
        raise ValueError(f"{field} must be timezone-aware")
    return value.astimezone(UTC)


def manifest_digest(manifest: RunManifest) -> str:
    """Digest a manifest over its canonical form, excluding storage identifiers.

    Task 0.1.
    """
    return manifest.digest
