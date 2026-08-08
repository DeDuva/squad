"""Google generateContent-shaped requests.

Structural facts that matter to the metric: the system instruction is a
request-level parameter, the assistant role is called ``model``, function
responses ride in a user-role content, and — the consequential one — a function
call and its response are matched **by name rather than by id**.

That last fact is the most interesting thing the probe finds on this pair. A
tool call's id and a tool result's binding to it are attributes, so both survive
as transforms rather than losses: the model still sees the call and the answer.
But a trajectory with two concurrent calls to the same tool loses which answer
belongs to which call, and no amount of care in the translator recovers it.

What this format cannot carry: a reasoning trace as replayable transcript
content, its signature, and a citation span. A prefill arrives as a completed
model turn.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from adp_replay.context.canonical import CanonicalContext, Element, Role, Turn, build
from adp_replay.context.providers.base import first, group_turns
from adp_replay.context.registered import ElementType

_WIRE_ROLE = {Role.USER: "user", Role.ASSISTANT: "model", Role.TOOL: "user"}
_MODE_OUT = {"auto": "AUTO", "none": "NONE", "required": "ANY", "named": "ANY"}


class GoogleTranslator:
    name = "google"

    def render(self, context: CanonicalContext) -> dict[str, Any]:
        request: dict[str, Any] = {}

        if system := first(context, ElementType.SYSTEM_INSTRUCTION):
            request["systemInstruction"] = {"parts": [{"text": system.payload["text"]}]}

        declarations = [
            {
                "name": tool.payload["name"],
                "description": tool.payload.get("description", ""),
                "parameters": tool.payload["schema"],
            }
            for tool in context.of_type(ElementType.TOOL_DEFINITION)
        ]
        if declarations:
            request["tools"] = [{"functionDeclarations": declarations}]

        if choice := first(context, ElementType.TOOL_CHOICE):
            mode = str(choice.payload["mode"])
            config: dict[str, Any] = {"mode": _MODE_OUT[mode]}
            if mode == "named":
                # ANY plus a one-element allow-list is how "call exactly this
                # tool" is said here, and it parses back unambiguously.
                config["allowedFunctionNames"] = [choice.payload["name"]]
            request["toolConfig"] = {"functionCallingConfig": config}

        if sampling := first(context, ElementType.SAMPLING_PARAMS):
            generation: dict[str, Any] = {}
            for canonical_key, wire_key in (
                ("temperature", "temperature"),
                ("top_p", "topP"),
                ("max_tokens", "maxOutputTokens"),
                ("stop_sequences", "stopSequences"),
            ):
                if (value := sampling.payload.get(canonical_key)) is not None:
                    generation[wire_key] = value
            if generation:
                request["generationConfig"] = generation

        # A function response needs a name, and the canonical form does not
        # carry one on a result: the binding is the call id. Resolving it here
        # is the translator doing its best, and what it cannot do is carry the
        # id itself — which is what makes concurrent calls to one tool the
        # interesting loss on this pair.
        call_names = {
            element.payload.get("id", ""): element.payload["name"]
            for element in context.of_type(ElementType.TOOL_CALL)
        }

        contents: list[dict[str, Any]] = []
        for role, parts in group_turns(context.turns(), _WIRE_ROLE):
            rendered = self._parts(parts, call_names)
            if rendered:
                contents.append({"role": role, "parts": rendered})
        if contents:
            request["contents"] = contents

        return request

    def _parts(self, parts: list[Element], call_names: Mapping[str, str]) -> list[dict[str, Any]]:
        rendered: list[dict[str, Any]] = []
        for part in parts:
            match part.type:
                case (
                    ElementType.USER_MESSAGE_TEXT
                    | ElementType.ASSISTANT_MESSAGE_TEXT
                    | ElementType.ASSISTANT_PREFILL
                ):
                    rendered.append({"text": part.payload["text"]})
                case ElementType.TOOL_CALL:
                    # No id on the wire. The call survives; the binding does not.
                    rendered.append(
                        {
                            "functionCall": {
                                "name": part.payload["name"],
                                "args": part.payload["arguments"],
                            }
                        }
                    )
                case ElementType.TOOL_RESULT:
                    rendered.append(
                        {
                            "functionResponse": {
                                "name": call_names.get(part.payload.get("call_id", ""), ""),
                                "response": {"content": part.payload["content"]},
                            }
                        }
                    )
                case ElementType.IMAGE_ATTACHMENT | ElementType.DOCUMENT_ATTACHMENT:
                    rendered.append(
                        {
                            "inlineData": {
                                "mimeType": part.payload["media_type"],
                                "data": part.payload["data"],
                            }
                        }
                    )
                case _:
                    pass
        return rendered

    def parse(self, request: Mapping[str, Any]) -> CanonicalContext:
        system: str | None = None
        if instruction := request.get("systemInstruction"):
            system = instruction["parts"][0]["text"]

        tools = [
            {
                "name": declaration["name"],
                "description": declaration.get("description", ""),
                "schema": declaration["parameters"],
            }
            for block in request.get("tools", [])
            for declaration in block.get("functionDeclarations", [])
        ]

        tool_choice: dict[str, Any] | None = None
        if config := request.get("toolConfig", {}).get("functionCallingConfig"):
            allowed = config.get("allowedFunctionNames") or []
            if config["mode"] == "ANY" and len(allowed) == 1:
                tool_choice = {"mode": "named", "name": allowed[0]}
            else:
                tool_choice = {
                    "mode": {"AUTO": "auto", "NONE": "none", "ANY": "required"}[config["mode"]]
                }

        sampling: dict[str, Any] = {}
        generation = request.get("generationConfig", {})
        for wire_key, canonical_key in (
            ("temperature", "temperature"),
            ("topP", "top_p"),
            ("maxOutputTokens", "max_tokens"),
            ("stopSequences", "stop_sequences"),
        ):
            if wire_key in generation:
                sampling[canonical_key] = generation[wire_key]

        turns: list[Turn] = []
        for content in request.get("contents", []):
            turns.extend(self._turns(content))

        return build(
            system=system,
            tools=tools,
            tool_choice=tool_choice,
            sampling=sampling or None,
            turns=turns,
        )

    def _turns(self, content: Mapping[str, Any]) -> list[Turn]:
        parts = list(content.get("parts", []))
        if content["role"] == "model":
            model_parts: list[Element] = []
            for part in parts:
                if "text" in part:
                    model_parts.append(
                        Element(ElementType.ASSISTANT_MESSAGE_TEXT, {"text": part["text"]})
                    )
                elif "functionCall" in part:
                    model_parts.append(
                        Element(
                            ElementType.TOOL_CALL,
                            {
                                "name": part["functionCall"]["name"],
                                "arguments": part["functionCall"]["args"],
                            },
                        )
                    )
            return [Turn(Role.ASSISTANT, tuple(model_parts))]

        # As with Anthropic, a user-role content carrying function responses is
        # a tool turn that the format merged into a user one.
        tool_parts: list[Element] = []
        user_parts: list[Element] = []
        for part in parts:
            if "functionResponse" in part:
                # No call id survives. The result arrives, and which call it
                # answers does not.
                response = part["functionResponse"]
                tool_parts.append(
                    Element(
                        ElementType.TOOL_RESULT,
                        {"content": response["response"]["content"]},
                    )
                )
            elif "text" in part:
                user_parts.append(Element(ElementType.USER_MESSAGE_TEXT, {"text": part["text"]}))
            elif "inlineData" in part:
                media_type = part["inlineData"]["mimeType"]
                kind = (
                    ElementType.IMAGE_ATTACHMENT
                    if media_type.startswith("image/")
                    else ElementType.DOCUMENT_ATTACHMENT
                )
                user_parts.append(
                    Element(kind, {"media_type": media_type, "data": part["inlineData"]["data"]})
                )

        turns: list[Turn] = []
        if tool_parts:
            turns.append(Turn(Role.TOOL, tuple(tool_parts)))
        if user_parts:
            turns.append(Turn(Role.USER, tuple(user_parts)))
        return turns
