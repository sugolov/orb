"""ClaudeComputerBackend — stub.

Anthropic's computer-use tool (or a local pyautogui/playwright wrapper)
to drive a browser/desktop session. Significant infra needed: virtual
display, screenshot pipeline, action recording. Likely BLOCKED until
the user supplies a host environment for it.

For now this is a stub — `is_available()` returns False; computer-typed
orbs will fall back to Echo.
"""

from __future__ import annotations

from typing import ClassVar

from .base import AgentBackend, AgentCallbacks


class ClaudeComputerBackend(AgentBackend):
    id: ClassVar[str] = "claude-computer"
    display_name: ClassVar[str] = "Claude (computer-use)"
    agent_type: ClassVar[str] = "computer"
    description: ClassVar[str] = (
        "Anthropic Claude with computer-use tools. Stub — requires "
        "screenshot + input infra."
    )

    @classmethod
    def is_available(cls) -> bool:
        return False

    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        raise NotImplementedError(
            "ClaudeComputerBackend not yet wired (host environment)"
        )
