"""The Phase-0 probe corpus.

G0 has to be answered before the recorder exists, so there are no real recorded
trajectories to score yet. This corpus stands in: hand-built agent trajectories
chosen to span the element vocabulary, so that every registered element type is
exercised by at least one task and the pairs are not scored only on the easy
parts.

Two honesty requirements follow from that, and both are enforced rather than
promised. The corpus carries a digest, reprinted in the G0 report, so a reading
taken against these contexts is never mistaken for one taken against recorded
ones. And the corpus is authored in the *richest* format's vocabulary —
reasoning traces with signatures, documents, citations, a prefill — because a
corpus that only contained what every provider can express would measure nothing.

Contexts sourced from another provider are derived rather than re-authored:
``as_sourced_from`` takes the fixed point of that provider's own representation,
which is exactly what a context recorded there would have contained.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from adp_replay.context.canonical import CanonicalContext, Element, Role, Turn, build
from adp_replay.context.providers.base import Translator, round_trip
from adp_replay.context.registered import ElementType


def _text(kind: ElementType, value: str) -> Element:
    return Element(kind, {"text": value})


def _call(call_id: str, name: str, arguments: Mapping[str, Any]) -> Element:
    return Element(ElementType.TOOL_CALL, {"id": call_id, "name": name, "arguments": arguments})


def _result(call_id: str, content: str, *, is_error: bool = False) -> Element:
    payload: dict[str, Any] = {"call_id": call_id, "content": content}
    if is_error:
        payload["is_error"] = True
    return Element(ElementType.TOOL_RESULT, payload)


BASH = {
    "name": "bash",
    "description": "Run a shell command in the task container.",
    "schema": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}
EDIT = {
    "name": "edit_file",
    "description": "Replace a span of a file.",
    "schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "old": {"type": "string"},
            "new": {"type": "string"},
        },
        "required": ["path", "old", "new"],
    },
}

SAMPLING = {
    "temperature": 0.0,
    "top_p": 0.95,
    "max_tokens": 4096,
    "stop_sequences": ["</done>"],
}


@dataclass(frozen=True)
class CorpusTask:
    """One trajectory, from which both capabilities' contexts are derived."""

    task_id: str
    system: str
    tools: tuple[Mapping[str, Any], ...]
    turns: tuple[Turn, ...]
    tool_choice: Mapping[str, Any] = field(default_factory=lambda: {"mode": "auto"})
    sampling: Mapping[str, Any] = field(default_factory=lambda: dict(SAMPLING))

    def context(self, through_turn: int) -> CanonicalContext:
        return build(
            system=self.system,
            tools=self.tools,
            tool_choice=self.tool_choice,
            sampling=self.sampling,
            turns=self.turns[:through_turn],
            labels={"task_id": self.task_id, "turns": str(through_turn)},
        )

    def initial_context(self) -> CanonicalContext:
        """What fork-at-zero translates: the request, and the task statement."""
        return self.context(1)

    def step_contexts(self) -> tuple[CanonicalContext, ...]:
        """What fork-at-step translates: every prefix the model could resume from.

        Prefixes end where the model is next to act — after a user or tool turn —
        because those are the only points a continuation actually starts from.
        Scoring prefixes that end mid-assistant-turn would pad the distribution
        with contexts no replay ever builds.
        """
        resumable = [
            index + 1
            for index, turn in enumerate(self.turns)
            if turn.role in (Role.USER, Role.TOOL)
        ]
        return tuple(self.context(k) for k in resumable if k > 1)


PHASE0_CORPUS: tuple[CorpusTask, ...] = (
    CorpusTask(
        task_id="tb2/fix-flaky-test",
        system="You are a software engineer working in a sealed container. Use the tools.",
        tools=(BASH, EDIT),
        turns=(
            Turn(
                Role.USER,
                (_text(ElementType.USER_MESSAGE_TEXT, "test_retry is flaky. Make it pass."),),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    _text(
                        ElementType.REASONING_TRACE,
                        "Flaky usually means a timing assumption. Read the test first.",
                    ),
                    Element(ElementType.REASONING_SIGNATURE, {"signature": "sig-aXZ1"}),
                    _text(ElementType.ASSISTANT_MESSAGE_TEXT, "Let me look at the test."),
                    _call("call_1", "bash", {"command": "cat tests/test_retry.py"}),
                ),
            ),
            Turn(Role.TOOL, (_result("call_1", "def test_retry():\n    sleep(0.01)"),)),
            Turn(
                Role.ASSISTANT,
                (
                    _text(
                        ElementType.REASONING_TRACE,
                        "A hard-coded sleep. Replace it with a deterministic clock.",
                    ),
                    Element(ElementType.REASONING_SIGNATURE, {"signature": "sig-bY72"}),
                    _call(
                        "call_2",
                        "edit_file",
                        {
                            "path": "tests/test_retry.py",
                            "old": "sleep(0.01)",
                            "new": "clock.tick()",
                        },
                    ),
                ),
            ),
            Turn(Role.TOOL, (_result("call_2", "ok"),)),
            Turn(
                Role.USER,
                (_text(ElementType.USER_MESSAGE_TEXT, "Run the suite before you finish."),),
            ),
        ),
    ),
    CorpusTask(
        task_id="tb2/read-the-screenshot",
        system="Diagnose from the attached evidence. Cite what you used.",
        tools=(BASH,),
        turns=(
            Turn(
                Role.USER,
                (
                    _text(ElementType.USER_MESSAGE_TEXT, "The dashboard is wrong. See attached."),
                    Element(
                        ElementType.IMAGE_ATTACHMENT,
                        {"media_type": "image/png", "data": "iVBORw0KGgoAAAANS"},
                    ),
                ),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    _text(
                        ElementType.ASSISTANT_MESSAGE_TEXT,
                        "The y-axis is truncated at 40, per the screenshot.",
                    ),
                    Element(
                        ElementType.CITATION_ANNOTATION,
                        {"source": "dashboard.png", "text": "y-axis max 40"},
                    ),
                    _call("call_1", "bash", {"command": "grep -rn 'ymax' src/"}),
                ),
            ),
            Turn(Role.TOOL, (_result("call_1", "src/chart.py:12: ymax = 40"),)),
        ),
    ),
    CorpusTask(
        task_id="tb2/migrate-config",
        system="Migrate the configuration to the schema in the attached specification.",
        tools=(BASH, EDIT),
        tool_choice={"mode": "required"},
        turns=(
            Turn(
                Role.USER,
                (
                    _text(ElementType.USER_MESSAGE_TEXT, "Migrate config.toml to v2."),
                    Element(
                        ElementType.DOCUMENT_ATTACHMENT,
                        {
                            "media_type": "application/pdf",
                            "data": "JVBERi0xLjcKJeLj",
                            "name": "schema-v2.pdf",
                        },
                    ),
                ),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    # Two concurrent calls to the same tool: the case where a
                    # format that matches results by name rather than by id
                    # cannot recover which answer belongs to which call.
                    _call("call_1", "bash", {"command": "cat config.toml"}),
                    _call("call_2", "bash", {"command": "cat config.v2.example"}),
                ),
            ),
            Turn(
                Role.TOOL,
                (
                    _result("call_1", "[server]\nport = 8080"),
                    _result("call_2", "[net]\nlisten = ':8080'"),
                ),
            ),
        ),
    ),
    CorpusTask(
        task_id="tb2/patch-the-cli",
        system="Fix the reported bug. Do not change public behaviour.",
        tools=(BASH, EDIT),
        tool_choice={"mode": "named", "name": "bash"},
        turns=(
            Turn(
                Role.USER,
                (_text(ElementType.USER_MESSAGE_TEXT, "`cli --json` prints nothing on empty."),),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    _text(ElementType.ASSISTANT_MESSAGE_TEXT, "Reproducing."),
                    _call("call_1", "bash", {"command": "cli --json < /dev/null"}),
                ),
            ),
            Turn(
                Role.TOOL,
                (_result("call_1", "Traceback: StopIteration", is_error=True),),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    _call(
                        "call_2",
                        "edit_file",
                        {"path": "cli.py", "old": "next(rows)", "new": "next(rows, None)"},
                    ),
                ),
            ),
            Turn(Role.TOOL, (_result("call_2", "ok"),)),
        ),
    ),
    CorpusTask(
        task_id="tb2/finish-the-sentence",
        system="Complete the incident report. Keep the established format.",
        tools=(BASH,),
        turns=(
            Turn(
                Role.USER,
                (_text(ElementType.USER_MESSAGE_TEXT, "Write the root-cause section."),),
            ),
            Turn(
                Role.ASSISTANT,
                (
                    _text(ElementType.ASSISTANT_MESSAGE_TEXT, "Checking the timeline first."),
                    _call("call_1", "bash", {"command": "cat incident/timeline.md"}),
                ),
            ),
            Turn(Role.TOOL, (_result("call_1", "03:12 deploy\n03:14 error rate 100%"),)),
            # A prefill: the model is required to continue this text, not to
            # reply to it.
            Turn(
                Role.ASSISTANT,
                (_text(ElementType.ASSISTANT_PREFILL, "## Root cause\n\nThe 03:12 deploy"),),
            ),
        ),
    ),
)


def as_sourced_from(context: CanonicalContext, translator: Translator) -> CanonicalContext:
    """The context as it would have been had it been recorded from that provider.

    The fixed point of the provider's own representation: whatever it cannot
    express was never in a context recorded there in the first place, so scoring
    a pair out of it must not charge the target for a loss the source never had.
    """
    return round_trip(context, translator)


def corpus_digest(tasks: Sequence[CorpusTask] = PHASE0_CORPUS) -> str:
    """Identifies which contexts a reading was taken against."""
    payload = [
        {
            "task_id": task.task_id,
            "system": task.system,
            "tools": [dict(tool) for tool in task.tools],
            "tool_choice": dict(task.tool_choice),
            "sampling": dict(task.sampling),
            "turns": [
                {
                    "role": turn.role.value,
                    "parts": [
                        {"type": part.type.value, "payload": dict(part.payload)}
                        for part in turn.parts
                    ],
                }
                for turn in task.turns
            ],
        }
        for task in tasks
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()
