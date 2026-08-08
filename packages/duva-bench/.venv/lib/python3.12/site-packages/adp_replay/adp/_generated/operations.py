"""ADP wire surface, generated from spec/adp-openapi.json.

DO NOT EDIT. Regenerate with `make generate`; `make check-generated`
fails while this file disagrees with the vendored document.

Only the native plane (/api/adp) is generated. The compat plane is
GitHub's shape, served so that unmodified `gh` works, and is not this
client's business.
"""

from __future__ import annotations

from typing import Final, NamedTuple


class Operation(NamedTuple):
    """One endpoint, exactly as the contract describes it."""

    key: str
    method: str
    path: str
    path_params: tuple[str, ...]
    query_params: tuple[str, ...]
    required_fields: tuple[str, ...]
    body_required: bool
    statuses: tuple[str, ...]
    requires_auth: bool
    summary: str

    def url(self, base_url: str, **params: str) -> str:
        """Interpolate the path template, refusing an incomplete call."""
        missing = [name for name in self.path_params if name not in params]
        if missing:
            raise KeyError(f'{self.key} needs path parameters: {missing}')
        path = self.path
        for name in self.path_params:
            path = path.replace('{' + name + '}', str(params[name]))
        return base_url.rstrip('/') + path


SPEC_VERSION: Final = "0.1.0"
SPEC_DIGEST: Final = "sha256:dcf27a36ca43a2a3063ac5b6d2280b9cdef168cd89eac62ad244cc21db05f75f"

OPERATIONS: Final[dict[str, Operation]] = {
    "delete_repos_by_owner_by_repo_workspaces_by_id": Operation(
        key="delete_repos_by_owner_by_repo_workspaces_by_id",
        method="DELETE",
        path="/api/adp/repos/{owner}/{repo}/workspaces/{id}",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("204", "422"),
        requires_auth=True,
        summary="Destroy a workspace: deletes its branch and stamps `destroyedAt`. The row is kept so the operation log stays a complete history.",
    ),
    "get_repos_by_owner_by_repo_candidate_sets": Operation(
        key="get_repos_by_owner_by_repo_candidate_sets",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/candidate-sets",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="List candidate sets, newest first.",
    ),
    "get_repos_by_owner_by_repo_candidate_sets_by_id": Operation(
        key="get_repos_by_owner_by_repo_candidate_sets_by_id",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/candidate-sets/{id}",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A candidate set with every candidate's head sha, score, and gate verdicts \u2014 the comparison view's read model.",
    ),
    "get_repos_by_owner_by_repo_evidence_by_sha": Operation(
        key="get_repos_by_owner_by_repo_evidence_by_sha",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/evidence/{sha}",
        path_params=("owner", "repo", "sha"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="The consolidated evidence bundle for a commit: its signed change plus every gate result's DSSE envelope. One read answers \"what landed, who produced it, and how was it verified\".",
    ),
    "get_repos_by_owner_by_repo_operations": Operation(
        key="get_repos_by_owner_by_repo_operations",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/operations",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="The append-only operation log \u2014 every mutation, written in the same transaction as the state change it describes. Filterable by `verb`, `actor`, `path`, `since`, `until`, `limit`.",
    ),
    "get_repos_by_owner_by_repo_operations_by_id": Operation(
        key="get_repos_by_owner_by_repo_operations_by_id",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/operations/{id}",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A single operation.",
    ),
    "get_repos_by_owner_by_repo_runs": Operation(
        key="get_repos_by_owner_by_repo_runs",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs",
        path_params=("owner", "repo"),
        query_params=("intent_id", "limit", "status"),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="Runs in this repository, newest first.",
    ),
    "get_repos_by_owner_by_repo_runs_by_run_id": Operation(
        key="get_repos_by_owner_by_repo_runs_by_run_id",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A run with its sessions, their chain heads, and its evals.",
    ),
    "get_repos_by_owner_by_repo_runs_by_run_id_evals": Operation(
        key="get_repos_by_owner_by_repo_runs_by_run_id_evals",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/evals",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="The evals recorded against this run, newest first, each carrying `reporter_principal` and `separately_authorized`.",
    ),
    "get_repos_by_owner_by_repo_runs_by_run_id_stats": Operation(
        key="get_repos_by_owner_by_repo_runs_by_run_id_stats",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/stats",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="What the run cost and what it spent it on: counts and tokens by event kind, per-tool call and failure counts, per-model spend, the handoff graph, and the commits the run produced.",
    ),
    "get_repos_by_owner_by_repo_runs_by_run_id_trajectory": Operation(
        key="get_repos_by_owner_by_repo_runs_by_run_id_trajectory",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/trajectory",
        path_params=("owner", "repo", "runId"),
        query_params=("kinds", "limit", "offset"),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="The run's whole trajectory, merged across its sessions in the order things actually happened.",
    ),
    "get_repos_by_owner_by_repo_runs_by_run_id_verify": Operation(
        key="get_repos_by_owner_by_repo_runs_by_run_id_verify",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/verify",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="Recompute every session's hash chain from the stored rows and check the run attestation against them. Tamper-evidence nobody can check is decoration; this is what makes the guarantee falsifiable by any holder of a read token. Reports where a chain first broke, by seq.",
    ),
    "get_repos_by_owner_by_repo_runs_compare": Operation(
        key="get_repos_by_owner_by_repo_runs_compare",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/runs/compare",
        path_params=("owner", "repo"),
        query_params=("eval", "intent_id", "limit"),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="N runs against one intent, each pairing its attested eval outcome with what the trajectory cost to produce it \u2014 the table eval-based optimization is read off. Ranked by score descending; unscored runs sort last, because unmeasured is not the same as scoring zero.",
    ),
    "get_repos_by_owner_by_repo_sessions_by_id": Operation(
        key="get_repos_by_owner_by_repo_sessions_by_id",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A session with its checkpoints and its full resume lineage \u2014 the chain back to the session that started the work, however many harnesses it passed through.",
    ),
    "get_repos_by_owner_by_repo_sessions_by_id_checkpoints": Operation(
        key="get_repos_by_owner_by_repo_sessions_by_id_checkpoints",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/checkpoints",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A session's checkpoints, in sequence order.",
    ),
    "get_repos_by_owner_by_repo_sessions_by_id_events": Operation(
        key="get_repos_by_owner_by_repo_sessions_by_id_events",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/events",
        path_params=("owner", "repo", "id"),
        query_params=("kinds", "limit", "since"),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="A session's trajectory in sequence order, with each event's chain hashes.",
    ),
    "get_repos_by_owner_by_repo_workspaces": Operation(
        key="get_repos_by_owner_by_repo_workspaces",
        method="GET",
        path="/api/adp/repos/{owner}/{repo}/workspaces",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200",),
        requires_auth=True,
        summary="List workspaces.",
    ),
    "post_repos_by_owner_by_repo_candidate_sets": Operation(
        key="post_repos_by_owner_by_repo_candidate_sets",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/candidate-sets",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=("intent_id",),
        body_required=True,
        statuses=("201", "422"),
        requires_auth=True,
        summary="Open a candidate set against one intent \u2014 N proposals fanned out, one selected. The MVP feature GitHub structurally cannot express (\u00a72.2). Proposals join by passing `candidate_set_id` at creation.",
    ),
    "post_repos_by_owner_by_repo_candidate_sets_by_id_resolve": Operation(
        key="post_repos_by_owner_by_repo_candidate_sets_by_id_resolve",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/candidate-sets/{id}/resolve",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "409", "422"),
        requires_auth=True,
        summary="Finish a fan-out: pick the winner by the set's selection policy, land it (squash \u2014 one landed change per set) through the ordinary land path, and reclaim the losers' workspaces. Losing proposals are closed and their branches deleted, but their rows and evidence are never removed: the discarded attempts stay queryable without polluting history. Land is serial \u2014 speculative batching is not implemented.",
    ),
    "post_repos_by_owner_by_repo_candidate_sets_by_id_select": Operation(
        key="post_repos_by_owner_by_repo_candidate_sets_by_id_select",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/candidate-sets/{id}/select",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=("proposal_id",),
        body_required=True,
        statuses=("200", "422"),
        requires_auth=True,
        summary="Record which candidate won. This only records the choice \u2014 /resolve is what acts on it.",
    ),
    "post_repos_by_owner_by_repo_operations_by_id_undo": Operation(
        key="post_repos_by_owner_by_repo_operations_by_id_undo",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/operations/{id}/undo",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "422"),
        requires_auth=True,
        summary="Undo an operation \u2014 operation-log undo with the causal record preserved, not revert-as-new-commit. The undo is itself an operation.",
    ),
    "post_repos_by_owner_by_repo_runs": Operation(
        key="post_repos_by_owner_by_repo_runs",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/runs",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=("intent_id", "orchestrator"),
        body_required=True,
        statuses=("200", "201", "409", "422"),
        requires_auth=True,
        summary="Open a run \u2014 an orchestrator's unit of assigned work, spanning the sessions it spawns to do it. `orchestrator` is opaque in the way `harness` is. When `external_ref` names a run that already exists, the existing run is returned with 200 instead of a second run being created, so an orchestrator restarting after a crash rejoins rather than forking the trajectory in two.",
    ),
    "post_repos_by_owner_by_repo_runs_by_run_id_abandon": Operation(
        key="post_repos_by_owner_by_repo_runs_by_run_id_abandon",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/abandon",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404", "409"),
        requires_auth=True,
        summary="Abandon a run that produced no commit. The trajectory is kept \u2014 the discarded attempts staying queryable is the point \u2014 and the run's sessions are closed.",
    ),
    "post_repos_by_owner_by_repo_runs_by_run_id_close": Operation(
        key="post_repos_by_owner_by_repo_runs_by_run_id_close",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/close",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=("final_git_sha",),
        body_required=True,
        statuses=("200", "404", "409", "422"),
        requires_auth=True,
        summary="Close a run against the commit it produced, signing a DSSE attestation that binds that sha to every session's trajectory chain head. Any still-open session is closed here: the attestation names each chain head, so a session that could still append afterwards would leave an attestation that no longer describes the trajectory. Idempotent on the same sha; 409 on a different one.",
    ),
    "post_repos_by_owner_by_repo_runs_by_run_id_evals": Operation(
        key="post_repos_by_owner_by_repo_runs_by_run_id_evals",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/runs/{runId}/evals",
        path_params=("owner", "repo", "runId"),
        query_params=(),
        required_fields=("name", "passed"),
        body_required=True,
        statuses=("201", "404", "422"),
        requires_auth=True,
        summary="Attach a deterministic eval result to a run, as gate evidence. The eval *is* a gate result \u2014 same signing, same table, same land policy and `gh pr checks` projection \u2014 and the signed predicate binds the score to the run, the commit, the trajectory digest, and the digest of the eval definition that produced it. Report under `gate_name: score` to feed a candidate set's `best_score` selection.",
    ),
    "post_repos_by_owner_by_repo_sessions": Operation(
        key="post_repos_by_owner_by_repo_sessions",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/sessions",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=("harness",),
        body_required=True,
        statuses=("201", "409", "422"),
        requires_auth=True,
        summary="Start a session \u2014 a unit of agent work that outlives any one harness. `harness` is an opaque identifier ADP never branches on; that is what makes the protocol harness-neutral rather than harness-aware.",
    ),
    "post_repos_by_owner_by_repo_sessions_by_id_checkpoints": Operation(
        key="post_repos_by_owner_by_repo_sessions_by_id_checkpoints",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/checkpoints",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=("git_sha",),
        body_required=True,
        statuses=("201", "409", "422"),
        requires_auth=True,
        summary="Checkpoint a session at a commit, with opaque harness state. The response's `envelope` is a signed DSSE statement binding the commit and a SHA-256 digest of `state` \u2014 see spec/schemas/checkpoint.json. `state` is never parsed by ADP, so a harness storing its own format needs no protocol change.",
    ),
    "post_repos_by_owner_by_repo_sessions_by_id_close": Operation(
        key="post_repos_by_owner_by_repo_sessions_by_id_close",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/close",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=(),
        body_required=False,
        statuses=("200", "404"),
        requires_auth=True,
        summary="Close a session. Idempotent.",
    ),
    "post_repos_by_owner_by_repo_sessions_by_id_events": Operation(
        key="post_repos_by_owner_by_repo_sessions_by_id_events",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/events",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=("events",),
        body_required=True,
        statuses=("201", "409", "422"),
        requires_auth=True,
        summary="Append to a session's trajectory \u2014 every message, model call, tool execution, handoff, commit, and test result. Events are hash-chained rather than individually signed: the chain head is what checkpoint and run attestations commit to, so recording stays cheap enough to always happen while tampering anywhere in the sequence stays detectable. Batched, and idempotent under retry when `client_event_id` is supplied.",
    ),
    "post_repos_by_owner_by_repo_sessions_by_id_resume": Operation(
        key="post_repos_by_owner_by_repo_sessions_by_id_resume",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/sessions/{id}/resume",
        path_params=("owner", "repo", "id"),
        query_params=(),
        required_fields=("harness",),
        body_required=True,
        statuses=("201", "404", "422"),
        requires_auth=True,
        summary="Resume a session under a (possibly different) harness. Verifies the checkpoint's DSSE signature **and** re-derives its state digest before forking a workspace at the checkpointed commit \u2014 an unverified resume would make \"one continuous signed history\" false while looking true. Creates a new session linked by `resumed_from_session_id`, and records `session.resume` with `parentOp` pointing at the checkpoint's own operation. The old session is never mutated beyond its status. Defaults to the latest checkpoint.",
    ),
    "post_repos_by_owner_by_repo_workspaces": Operation(
        key="post_repos_by_owner_by_repo_workspaces",
        method="POST",
        path="/api/adp/repos/{owner}/{repo}/workspaces",
        path_params=("owner", "repo"),
        query_params=(),
        required_fields=("base_ref",),
        body_required=True,
        statuses=("201", "422"),
        requires_auth=True,
        summary="Fork a workspace from a base ref. A workspace is deliberately just a branch `adp/ws/<id>` with lifecycle metadata \u2014 no new storage mechanism, no VFS.",
    ),
}


def operation(key: str) -> Operation:
    """Look up an operation, failing loudly when the contract dropped it.

    An endpoint that disappears from ADP's spec becomes an error here at
    the point of use rather than a 404 in the middle of an experiment.
    """
    try:
        return OPERATIONS[key]
    except KeyError:
        raise KeyError(
            f'{key!r} is not in ADP contract {SPEC_VERSION}; '
            'regenerate the client or stop calling it'
        ) from None
