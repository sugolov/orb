"""ClaudeChatBackend — Anthropic API, conversational.

Wraps the Anthropic SDK's streaming messages API. Used as the default
backend for `chat`-typed orbs whenever ANTHROPIC_API_KEY is configured.
Falls back to EchoBackend behavior at the registry level when the key
is missing.

Maintains an in-process message history so follow-up `send_message`
calls preserve multi-turn context — the system prompt is rebuilt
fresh per call (so the live tree-as-context walk is reflected) but
the user/assistant turn history accumulates here.
"""

from __future__ import annotations

import os
from typing import ClassVar

from anthropic import AsyncAnthropic

from .base import AgentBackend, AgentCallbacks


def _api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY")


def _model() -> str:
    return os.environ.get("ORB_MODEL", "claude-opus-4-5")


class ClaudeChatBackend(AgentBackend):
    id: ClassVar[str] = "claude-chat"
    display_name: ClassVar[str] = "Claude (chat)"
    agent_type: ClassVar[str] = "chat"
    description: ClassVar[str] = (
        "Anthropic Claude via the Messages API, streaming. Default "
        "for chat orbs when ANTHROPIC_API_KEY is set."
    )

    @classmethod
    def is_available(cls) -> bool:
        return bool(_api_key())

    def __init__(self, orb_id: str, config: dict | None = None) -> None:
        super().__init__(orb_id, config)
        # Per-instance message history. Survives across send_message
        # calls so the model sees the full conversation. Cleared on
        # stop().
        self.messages: list[dict[str, str]] = []

    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        self.messages = [{"role": "user", "content": prompt}]
        return await self._run_turn(system_prompt, callbacks)

    async def send_message(
        self,
        content: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        self.messages.append({"role": "user", "content": content})
        return await self._run_turn(system_prompt, callbacks)

    async def _run_turn(
        self, system_prompt: str, callbacks: AgentCallbacks
    ) -> str:
        key = _api_key()
        if not key:
            # Should never happen — registry filters this out, but keep
            # a defensive error path.
            raise RuntimeError("ANTHROPIC_API_KEY not configured")

        client = AsyncAnthropic(api_key=key)
        accumulated: list[str] = []
        async with client.messages.stream(
            model=_model(),
            max_tokens=1024,
            system=system_prompt,
            messages=self.messages,
        ) as stream:
            async for text in stream.text_stream:
                accumulated.append(text)
                if callbacks.on_chunk:
                    await callbacks.on_chunk(text)
        result = "".join(accumulated).strip()
        # append the assistant turn so subsequent send_message calls
        # see the full conversation
        self.messages.append({"role": "assistant", "content": result})
        return result
