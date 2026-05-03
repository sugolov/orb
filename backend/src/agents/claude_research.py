"""ClaudeResearchBackend — stub.

A research orb would use Anthropic with web search tools. Real
implementation depends on which web search provider gets wired up
(Brave / Exa / Tavily / Anthropic's own web search beta tool). For
now this is a stub — `is_available()` returns False so the registry
defaults code-orb dispatches to Echo.

When implementing: extend `ClaudeChatBackend`'s pattern, register a
`web_search`/`web_fetch` tool with the Anthropic SDK, route
`tool_use`/`tool_result` events to AgentCallbacks so the research
orchestrator's sources panel can populate live.
"""

from __future__ import annotations

from typing import ClassVar

from .base import AgentBackend, AgentCallbacks


class ClaudeResearchBackend(AgentBackend):
    id: ClassVar[str] = "claude-research"
    display_name: ClassVar[str] = "Claude (research)"
    agent_type: ClassVar[str] = "research"
    description: ClassVar[str] = (
        "Anthropic Claude with web search + fetch tools. Stub — "
        "requires a search provider integration."
    )

    @classmethod
    def is_available(cls) -> bool:
        # No provider wired yet. Mark as BLOCKED in PROGRESS.md when
        # the registry log notes this.
        return False

    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        raise NotImplementedError(
            "ClaudeResearchBackend not yet wired (web search provider)"
        )
