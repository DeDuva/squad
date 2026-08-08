"""OpenAI chat-completions-shaped requests.

Structural facts that matter to the metric: the system prompt is a message
rather than a request parameter, tool results get their own role and stay bound
to a call by id, tool-call arguments travel as a JSON *string*, and there is no
turn-merging constraint.

What this format cannot carry, and therefore what a translation into it drops: a
reasoning trace as replayable transcript content, the signature that would bind
one, a non-image attachment, and a citation span. An assistant prefill has
nowhere to be a prefill, so it arrives as a completed assistant turn — the
content survives and the instruction to continue it does not, which is the
definition of a transform rather than a loss.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from adp_replay.context.canonical import CanonicalContext, Element, Role, Turn, build
from adp_replay.context.providers.base import first, group_turns
from adp_replay.context.registered import ElementType

_WIRE_ROLE = {Role.USER: "user", Role.ASSISTANT: "assistant", Role.TOOL: "tool"}


class OpenAITranslator:
    name = "openai"

    def render(self, context: CanonicalContext) -> dict[str, Any]:
        request: dict[str, Any] = {}
        messages: list[dict[str, Any]] = []

        if system := first(context, ElementType.SYSTEM_INSTRUCTION):
            messages.append({"role": "system", "content": system.payload["text"]})

        tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.payload["name"],
                    "description": tool.payload.get("description", ""),
                    "parameters": tool.payload["schema"],
                },
            }
            for tool in context.of_type(ElementType.TOOL_DEFINITION)
        ]
        if tools:
            request["tools"] = tools

        if choice := first(context, ElementType.TOOL_CHOICE):
            mode = str(choice.payload["mode"])
            if mode == "named":
                request["tool_choice"] = {
                    "type": "function",
                    "function": {"name": choice.payload["name"]},
                }
            else:
                request["tool_choice"] = mode

        if sampling := first(context, ElementType.SAMPLING_PARAMS):
            for canonical_key, wire_key in (
                ("temperature", "temperature"),
                ("top_p", "top_p"),
                ("max_tokens", "max_tokens"),
                ("stop_sequences", "stop"),
            ):
                if (value := sampling.payload.get(canonical_key)) is not None:
                    request[wire_key] = value

        for role, parts in group_turns(context.turns(), _WIRE_ROLE):
            messages.extend(self._messages(role, parts))
        if messages:
            request["messages"] = messages

        return request

    def _messages(self, role: str, parts: list[Element]) -> list[dict[str, Any]]:
        if role == "tool":
            # One message per result: the role carries exactly one, keyed by the
            # call it answers.
            return [
                {
                    "role": "tool",
                    "tool_call_id": part.payload.get("call_id", ""),
                    "content": part.payload["content"],
                }
                for part in parts
                if part.type is ElementType.TOOL_RESULT
            ]

        if role == "assistant":
            text_parts = [
                part.payload["text"]
                for part in parts
                if part.type in (ElementType.ASSISTANT_MESSAGE_TEXT, ElementType.ASSISTANT_PREFILL)
            ]
            tool_calls = [
                {
                    "id": part.payload.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": part.payload["name"],
                        # Arguments are a JSON string on the wire. They come back
                        # equal after the registered normalization, so this is a
                        # serialization detail and not a loss.
                        "arguments": json.dumps(part.payload["arguments"], sort_keys=True),
                    },
                }
                for part in parts
                if part.type is ElementType.TOOL_CALL
            ]
            message: dict[str, Any] = {"role": "assistant", "content": "\n".join(text_parts)}
            if tool_calls:
                message["tool_calls"] = tool_calls
            return [message] if (text_parts or tool_calls) else []

        content: list[dict[str, Any]] = []
        for part in parts:
            if part.type is ElementType.USER_MESSAGE_TEXT:
                content.append({"type": "text", "text": part.payload["text"]})
            elif part.type is ElementType.IMAGE_ATTACHMENT:
                url = f"data:{part.payload['media_type']};base64,{part.payload['data']}"
                content.append({"type": "image_url", "image_url": {"url": url}})
            # A document has no representation here. It is dropped rather than
            # smuggled in as text: a PDF rendered as its own base64 is not the
            # document the recorded model saw, and scoring it as preserved would
            # be the metric lying about the replay.
        return [{"role": "user", "content": content}] if content else []

    def parse(self, request: Mapping[str, Any]) -> CanonicalContext:
        tools = [
            {
                "name": tool["function"]["name"],
                "description": tool["function"].get("description", ""),
                "schema": tool["function"]["parameters"],
            }
            for tool in request.get("tools", [])
        ]

        tool_choice: dict[str, Any] | None = None
        wire_choice = request.get("tool_choice")
        if isinstance(wire_choice, str):
            tool_choice = {"mode": wire_choice}
        elif isinstance(wire_choice, Mapping):
            tool_choice = {"mode": "named", "name": wire_choice["function"]["name"]}

        sampling: dict[str, Any] = {}
        for wire_key, canonical_key in (
            ("temperature", "temperature"),
            ("top_p", "top_p"),
            ("max_tokens", "max_tokens"),
            ("stop", "stop_sequences"),
        ):
            if wire_key in request:
                sampling[canonical_key] = request[wire_key]

        system: str | None = None
        turns: list[Turn] = []
        for message in request.get("messages", []):
            role = message["role"]
            if role in ("system", "developer"):
                system = message["content"]
            elif role == "tool":
                turns.append(
                    Turn(
                        Role.TOOL,
                        (
                            Element(
                                ElementType.TOOL_RESULT,
                                _result_payload(message),
                            ),
                        ),
                    )
                )
            elif role == "assistant":
                turns.append(Turn(Role.ASSISTANT, tuple(self._assistant_parts(message))))
            else:
                turns.append(Turn(Role.USER, tuple(self._user_parts(message))))

        return build(
            system=system,
            tools=tools,
            tool_choice=tool_choice,
            sampling=sampling or None,
            turns=turns,
        )

    def _assistant_parts(self, message: Mapping[str, Any]) -> list[Element]:
        parts: list[Element] = []
        if text := message.get("content"):
            parts.append(Element(ElementType.ASSISTANT_MESSAGE_TEXT, {"text": text}))
        for call in message.get("tool_calls", []):
            payload: dict[str, Any] = {
                "name": call["function"]["name"],
                "arguments": json.loads(call["function"]["arguments"]),
            }
            if call.get("id"):
                payload["id"] = call["id"]
            parts.append(Element(ElementType.TOOL_CALL, payload))
        return parts

    def _user_parts(self, message: Mapping[str, Any]) -> list[Element]:
        content = message.get("content", [])
        if isinstance(content, str):
            return [Element(ElementType.USER_MESSAGE_TEXT, {"text": content})]

        parts: list[Element] = []
        for block in content:
            if block["type"] == "text":
                parts.append(Element(ElementType.USER_MESSAGE_TEXT, {"text": block["text"]}))
            elif block["type"] == "image_url":
                url = block["image_url"]["url"]
                header, _, data = url.partition(",")
                media_type = header.removeprefix("data:").removesuffix(";base64")
                parts.append(
                    Element(ElementType.IMAGE_ATTACHMENT, {"media_type": media_type, "data": data})
                )
        return parts


def _result_payload(message: Mapping[str, Any]) -> dict[str, Any]:
    """A result, carrying its call id only when the format supplied one."""
    payload: dict[str, Any] = {"content": message["content"]}
    if message.get("tool_call_id"):
        payload["call_id"] = message["tool_call_id"]
    return payload
