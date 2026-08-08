"""Anthropic Messages-shaped requests.

The richest of the three formats in this repo's vocabulary: the only one that
carries reasoning traces with their signatures, documents, citations, and an
assistant prefill. That makes it the natural source format for a Phase-0 corpus
— a context recorded here can lose something on the way out, which is the thing
the probe is for.

Structural facts that matter to the metric: the system prompt is a request-level
parameter rather than a message, tool results ride inside a user message, and
consecutive same-role messages merge.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from adp_replay.context.canonical import CanonicalContext, Element, Role, Turn, build
from adp_replay.context.providers.base import first, group_turns
from adp_replay.context.registered import ElementType

_WIRE_ROLE = {Role.USER: "user", Role.ASSISTANT: "assistant", Role.TOOL: "user"}
_CHOICE_OUT = {"auto": "auto", "none": "none", "required": "any", "named": "tool"}
_CHOICE_IN = {"auto": "auto", "none": "none", "any": "required", "tool": "named"}


class AnthropicTranslator:
    name = "anthropic"

    def render(self, context: CanonicalContext) -> dict[str, Any]:
        request: dict[str, Any] = {}

        if system := first(context, ElementType.SYSTEM_INSTRUCTION):
            request["system"] = system.payload["text"]

        tools = [
            {
                "name": tool.payload["name"],
                "description": tool.payload.get("description", ""),
                "input_schema": tool.payload["schema"],
            }
            for tool in context.of_type(ElementType.TOOL_DEFINITION)
        ]
        if tools:
            request["tools"] = tools

        if choice := first(context, ElementType.TOOL_CHOICE):
            mode = str(choice.payload["mode"])
            rendered: dict[str, Any] = {"type": _CHOICE_OUT[mode]}
            if mode == "named":
                rendered["name"] = choice.payload["name"]
            request["tool_choice"] = rendered

        if sampling := first(context, ElementType.SAMPLING_PARAMS):
            for canonical_key, wire_key in (
                ("temperature", "temperature"),
                ("top_p", "top_p"),
                ("max_tokens", "max_tokens"),
                ("stop_sequences", "stop_sequences"),
            ):
                if (value := sampling.payload.get(canonical_key)) is not None:
                    request[wire_key] = value

        messages: list[dict[str, Any]] = []
        for role, parts in group_turns(context.turns(), _WIRE_ROLE):
            content = self._blocks(parts)
            if content:
                messages.append({"role": role, "content": content})
        if messages:
            request["messages"] = messages

        return request

    def _blocks(self, parts: list[Element]) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for part in parts:
            match part.type:
                case ElementType.REASONING_TRACE:
                    blocks.append({"type": "thinking", "thinking": part.payload["text"]})
                case ElementType.REASONING_SIGNATURE:
                    # Attaches to the thinking block it follows. A signature with
                    # no trace in front of it is dropped rather than invented a
                    # home for.
                    if blocks and blocks[-1]["type"] == "thinking":
                        blocks[-1]["signature"] = part.payload["signature"]
                case ElementType.ASSISTANT_MESSAGE_TEXT | ElementType.ASSISTANT_PREFILL:
                    blocks.append({"type": "text", "text": part.payload["text"]})
                case ElementType.CITATION_ANNOTATION:
                    if blocks and blocks[-1]["type"] == "text":
                        blocks[-1].setdefault("citations", []).append(
                            {"source": part.payload["source"], "cited_text": part.payload["text"]}
                        )
                case ElementType.TOOL_CALL:
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": part.payload.get("id", ""),
                            "name": part.payload["name"],
                            "input": part.payload["arguments"],
                        }
                    )
                case ElementType.TOOL_RESULT:
                    block: dict[str, Any] = {
                        "type": "tool_result",
                        "tool_use_id": part.payload.get("call_id", ""),
                        "content": part.payload["content"],
                    }
                    if part.payload.get("is_error"):
                        block["is_error"] = True
                    blocks.append(block)
                case ElementType.USER_MESSAGE_TEXT:
                    blocks.append({"type": "text", "text": part.payload["text"]})
                case ElementType.IMAGE_ATTACHMENT:
                    blocks.append(
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": part.payload["media_type"],
                                "data": part.payload["data"],
                            },
                        }
                    )
                case ElementType.DOCUMENT_ATTACHMENT:
                    blocks.append(
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": part.payload["media_type"],
                                "data": part.payload["data"],
                            },
                            "title": part.payload.get("name", ""),
                        }
                    )
                case _:
                    pass
        return blocks

    def parse(self, request: Mapping[str, Any]) -> CanonicalContext:
        tools = [
            {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "schema": tool["input_schema"],
            }
            for tool in request.get("tools", [])
        ]

        tool_choice: dict[str, Any] | None = None
        if wire_choice := request.get("tool_choice"):
            mode = _CHOICE_IN[wire_choice["type"]]
            tool_choice = {"mode": mode}
            if mode == "named":
                tool_choice["name"] = wire_choice["name"]

        sampling: dict[str, Any] | None = None
        collected = {
            key: request[key]
            for key in ("temperature", "top_p", "max_tokens", "stop_sequences")
            if key in request
        }
        if collected:
            sampling = collected

        messages = list(request.get("messages", []))
        turns: list[Turn] = []
        for index, message in enumerate(messages):
            is_last = index == len(messages) - 1
            turns.extend(self._turns(message, is_last=is_last))

        return build(
            system=request.get("system"),
            tools=tools,
            tool_choice=tool_choice,
            sampling=sampling,
            turns=turns,
        )

    def _turns(self, message: Mapping[str, Any], *, is_last: bool) -> list[Turn]:
        blocks = list(message.get("content", []))
        if message["role"] == "assistant":
            return [Turn(Role.ASSISTANT, tuple(self._assistant_parts(blocks, is_last=is_last)))]

        # A user message carrying tool results is two canonical turns, not one:
        # the tool turn came first and the format merged it. Splitting it back
        # out is what lets the role sequence record that a merge happened.
        tool_parts: list[Element] = []
        user_parts: list[Element] = []
        for block in blocks:
            if block["type"] == "tool_result":
                payload: dict[str, Any] = {"content": block["content"]}
                # Only when the format actually carried one. Materializing an
                # empty id would show up as an attribute the target added, and
                # the metric would score a transform that never happened.
                if block.get("tool_use_id"):
                    payload["call_id"] = block["tool_use_id"]
                if block.get("is_error"):
                    payload["is_error"] = True
                tool_parts.append(Element(ElementType.TOOL_RESULT, payload))
            elif block["type"] == "text":
                user_parts.append(Element(ElementType.USER_MESSAGE_TEXT, {"text": block["text"]}))
            elif block["type"] == "image":
                user_parts.append(
                    Element(
                        ElementType.IMAGE_ATTACHMENT,
                        {
                            "media_type": block["source"]["media_type"],
                            "data": block["source"]["data"],
                        },
                    )
                )
            elif block["type"] == "document":
                user_parts.append(
                    Element(
                        ElementType.DOCUMENT_ATTACHMENT,
                        {
                            "media_type": block["source"]["media_type"],
                            "data": block["source"]["data"],
                            "name": block.get("title", ""),
                        },
                    )
                )

        turns: list[Turn] = []
        if tool_parts:
            turns.append(Turn(Role.TOOL, tuple(tool_parts)))
        if user_parts:
            turns.append(Turn(Role.USER, tuple(user_parts)))
        return turns

    def _assistant_parts(self, blocks: list[Any], *, is_last: bool) -> list[Element]:
        parts: list[Element] = []
        for block in blocks:
            if block["type"] == "thinking":
                parts.append(Element(ElementType.REASONING_TRACE, {"text": block["thinking"]}))
                if signature := block.get("signature"):
                    parts.append(Element(ElementType.REASONING_SIGNATURE, {"signature": signature}))
            elif block["type"] == "text":
                # A trailing assistant message *is* a prefill here: the model is
                # asked to continue it rather than to reply to it.
                kind = (
                    ElementType.ASSISTANT_PREFILL
                    if is_last and len(blocks) == 1
                    else ElementType.ASSISTANT_MESSAGE_TEXT
                )
                parts.append(Element(kind, {"text": block["text"]}))
                for citation in block.get("citations", []):
                    parts.append(
                        Element(
                            ElementType.CITATION_ANNOTATION,
                            {"source": citation["source"], "text": citation["cited_text"]},
                        )
                    )
            elif block["type"] == "tool_use":
                call: dict[str, Any] = {
                    "name": block["name"],
                    "arguments": block["input"],
                }
                if block.get("id"):
                    call["id"] = block["id"]
                parts.append(Element(ElementType.TOOL_CALL, call))
        return parts
