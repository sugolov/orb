"""Echo backend — always-available stub for testing the plumbing.

Streams the prompt back as fake output, word by word, so animation /
streaming pipelines can be exercised without any external dependency.
Used as the universal fallback when a real backend isn't available
(e.g., no API key, CLI not installed).
"""

from __future__ import annotations

import asyncio
from typing import ClassVar

from .base import AgentBackend, AgentCallbacks


class EchoBackend(AgentBackend):
    id: ClassVar[str] = "echo"
    display_name: ClassVar[str] = "Echo"
    agent_type: ClassVar[str] = "chat"
    description: ClassVar[str] = (
        "Stub backend that echoes the prompt back. Always available; "
        "used to test plumbing without an API key."
    )

    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        text = f"(echo) {prompt}"
        accumulated: list[str] = []
        for chunk in text.split(" "):
            token = chunk + " "
            accumulated.append(token)
            if callbacks.on_chunk:
                await callbacks.on_chunk(token)
            await asyncio.sleep(0.03)
        return "".join(accumulated).strip()

    async def send_message(
        self,
        content: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        return await self.start(content, system_prompt, callbacks)
