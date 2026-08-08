"""Hand-written wrapper over the generated ADP client.

Only the surfaces docs/execution-plan.md §2 lists are exposed. Keeping the
wrapper narrow is deliberate: it is the seam that absorbs an ADP rewrite, and a
wrapper that re-exports everything absorbs nothing.

Paths, methods, and required fields are not written here — they come from
:mod:`adp_replay.adp._generated`, which comes from ADP's own document. What is
written here is transport policy: which identity signs which call, what an error
means, and which response shapes this client depends on.

Two identities, not one. A score is independent evidence only when the identity
that reported it is not the identity that did the work — ADP reports this as
``separately_authorized``. Passing the same token for both collapses that
distinction into a self-report that still looks like a score, so the constructor
refuses it, and Task 2.3 asserts the same thing again before any spend.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self

import httpx

from adp_replay.adp._generated import Operation, operation
from adp_replay.adp.version import VERSION_HEADER, assert_api_version

DEFAULT_TIMEOUT = 30.0


class AdpError(RuntimeError):
    """An ADP call that did not succeed."""

    def __init__(self, message: str, *, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class AppendRejected(AdpError):
    """A 409 from the events endpoint.

    Two different conditions share the status. ``expected_next_seq`` is set when
    the batch skipped the emitter's numbering, and it is the resume point a
    spool replays from (Task 1.4); it is None when the session was closed, which
    no amount of replaying fixes.
    """

    def __init__(self, message: str, *, status: int, body: Any = None) -> None:
        super().__init__(message, status=status, body=body)
        self.expected_next_seq: int | None = None
        if isinstance(body, dict):
            value = body.get("expected_next_seq")
            self.expected_next_seq = value if isinstance(value, int) else None


@dataclass(frozen=True)
class AppendReceipt:
    """What ADP says it durably holds after an append.

    ``accepted_through`` is the mark a spool trims against, and is None when the
    batch carried no ``producer_seq`` — an emitter that does not count is
    untracked, not incomplete.

    ``duplicates`` holds the ``client_event_id``s ADP dropped as already-seen.
    A non-empty one is a bug signal rather than normal traffic: it means this
    client sent something twice believing it had not.

    The field names are ADP's, taken from what the server actually returns
    rather than from the spec, which documents these responses in prose only.
    That gap is why `tests/contract/` exists.
    """

    chain_head: str | None
    accepted_through: int | None
    appended: int
    duplicates: tuple[str, ...]
    count: int

    @property
    def duplicate_count(self) -> int:
        return len(self.duplicates)


class AdpClient:
    """Client for ADP's native plane."""

    def __init__(
        self,
        base_url: str,
        *,
        runner_token: str,
        scorer_token: str,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
        allow_compatible_version: bool = False,
    ) -> None:
        if not runner_token or not scorer_token:
            raise ValueError("both a runner token and a scorer token are required")
        if runner_token == scorer_token:
            raise ValueError(
                "the runner and scorer tokens are the same principal, so every score would "
                "be a self-report and separately_authorized would be false. Issue a second "
                "token before recording anything."
            )

        self.base_url = base_url.rstrip("/")
        self._runner_token = runner_token
        self._scorer_token = scorer_token
        self._allow_compatible_version = allow_compatible_version
        self._http = httpx.Client(timeout=timeout, transport=transport)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    # --- contract pinning -----------------------------------------------------

    def assert_contract(self) -> str:
        """Check the served contract before anything else happens.

        Deliberately tolerant of the response: ADP sets the header on 401s and
        404s too, so this works before a token has been proven good, which is
        the case worth catching — a client pointed at the wrong instance.
        """
        response = self._http.get(f"{self.base_url}/api/adp/repos/_/_/runs")
        served: str | None = response.headers.get(VERSION_HEADER)
        assert_api_version(served, allow_compatible=self._allow_compatible_version)
        assert served is not None  # assert_api_version rejects None
        return served

    # --- the surfaces §2 lists ------------------------------------------------

    def create_session(
        self, owner: str, repo: str, *, harness: str, **fields: Any
    ) -> dict[str, Any]:
        """POST /api/adp/repos/{owner}/{repo}/sessions"""
        return self._call(
            operation("post_repos_by_owner_by_repo_sessions"),
            {"owner": owner, "repo": repo},
            body={"harness": harness, **fields},
        )

    def create_run(self, owner: str, repo: str, **fields: Any) -> dict[str, Any]:
        """POST /api/adp/repos/{owner}/{repo}/runs"""
        return self._call(
            operation("post_repos_by_owner_by_repo_runs"),
            {"owner": owner, "repo": repo},
            body=fields,
        )

    def append_events(
        self,
        owner: str,
        repo: str,
        session_id: str,
        events: list[dict[str, Any]],
        *,
        producer_id: str | None = None,
    ) -> AppendReceipt:
        """POST .../sessions/{id}/events — batched; carries ``producer_seq``.

        Raises :class:`AppendRejected` on a 409, carrying ``expected_next_seq``
        when ADP supplied one, so the spool replays from there rather than
        guessing (Task 1.4).
        """
        # ADP's spec marks `payload` optional — only `kind` is required — but the
        # column behind it is NOT NULL, so an event without one is a 500 rather
        # than a 201 or a 422. Defaulting it here is a workaround for a server
        # bug (reported in docs/adp-contract-findings.md), not a modelling
        # choice: a recorder must not be able to take down its own run by
        # emitting an event the contract says is legal.
        normalized = [
            {**event, "payload": event.get("payload", {})} if "payload" not in event else event
            for event in events
        ]

        body: dict[str, Any] = {"events": normalized}
        if producer_id is not None:
            body["producer_id"] = producer_id

        payload = self._call(
            operation("post_repos_by_owner_by_repo_sessions_by_id_events"),
            {"owner": owner, "repo": repo, "id": session_id},
            body=body,
        )
        duplicates = payload.get("duplicates") or ()
        return AppendReceipt(
            chain_head=payload.get("head"),
            accepted_through=payload.get("accepted_through"),
            appended=int(payload.get("appended") or 0),
            duplicates=tuple(str(item) for item in duplicates),
            count=int(payload.get("count") or 0),
        )

    def create_checkpoint(
        self, owner: str, repo: str, session_id: str, *, git_sha: str, state: Any, **fields: Any
    ) -> dict[str, Any]:
        """POST .../sessions/{id}/checkpoints — attests a snapshot digest.

        ``state`` is opaque to ADP and never parsed by it, so the snapshot
        manifest format stays this project's business (Task 1.1).
        """
        return self._call(
            operation("post_repos_by_owner_by_repo_sessions_by_id_checkpoints"),
            {"owner": owner, "repo": repo, "id": session_id},
            body={"git_sha": git_sha, "state": state, **fields},
        )

    def close_run(
        self, owner: str, repo: str, run_id: str, *, final_git_sha: str
    ) -> dict[str, Any]:
        """POST .../runs/{runId}/close"""
        return self._call(
            operation("post_repos_by_owner_by_repo_runs_by_run_id_close"),
            {"owner": owner, "repo": repo, "runId": run_id},
            body={"final_git_sha": final_git_sha},
        )

    def report_eval(self, owner: str, repo: str, run_id: str, **fields: Any) -> dict[str, Any]:
        """POST .../runs/{runId}/evals — sent with the *scorer* token."""
        return self._call(
            operation("post_repos_by_owner_by_repo_runs_by_run_id_evals"),
            {"owner": owner, "repo": repo, "runId": run_id},
            body=fields,
            token=self._scorer_token,
        )

    def verify_run(self, owner: str, repo: str, run_id: str) -> dict[str, Any]:
        """GET .../runs/{runId}/verify — the evidence-gating primitive (Task 3.3)."""
        return self._call(
            operation("get_repos_by_owner_by_repo_runs_by_run_id_verify"),
            {"owner": owner, "repo": repo, "runId": run_id},
        )

    # --- transport ------------------------------------------------------------

    def _call(
        self,
        op: Operation,
        params: dict[str, str],
        *,
        body: dict[str, Any] | None = None,
        token: str | None = None,
    ) -> dict[str, Any]:
        if body is not None:
            missing = [name for name in op.required_fields if name not in body]
            if missing:
                # The contract says these are required. Checking here turns a
                # 422 halfway through a recording into a programming error at
                # the call site.
                raise ValueError(f"{op.key} requires {missing}")

        response = self._http.request(
            op.method,
            op.url(self.base_url, **params),
            json=body,
            headers={"Authorization": f"Bearer {token or self._runner_token}"},
        )

        payload: Any = None
        if response.content:
            try:
                payload = response.json()
            except ValueError:
                payload = response.text

        if response.is_success:
            return payload if isinstance(payload, dict) else {"body": payload}

        message = f"{op.method} {op.path} -> {response.status_code}"
        if response.status_code == 409 and op.key.endswith("events"):
            raise AppendRejected(message, status=response.status_code, body=payload)
        raise AdpError(message, status=response.status_code, body=payload)
