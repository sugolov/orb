"""Central registry for agent backends.

Add a new backend by importing it here and appending to `_BACKENDS`.
The frontend reads this list via `GET /api/agent-backends` (registered
in main.py) to populate the dispatcher's agent dropdown.
"""

from __future__ import annotations

from typing import Type

from .base import AgentBackend, BackendInfo
from .claude_chat import ClaudeChatBackend
from .claude_code import ClaudeCodeBackend
from .claude_computer import ClaudeComputerBackend
from .claude_research import ClaudeResearchBackend
from .echo import EchoBackend

_BACKENDS: list[Type[AgentBackend]] = [
    EchoBackend,
    ClaudeChatBackend,
    ClaudeCodeBackend,
    ClaudeResearchBackend,
    ClaudeComputerBackend,
]


def all_backends() -> list[Type[AgentBackend]]:
    """Every registered backend, regardless of availability. Used by
    the frontend dropdown's "+ other" affordance to expand outside
    the orchestrator's agent_type."""
    return list(_BACKENDS)


def available_backends() -> list[Type[AgentBackend]]:
    """Backends whose env requirements are satisfied."""
    return [b for b in _BACKENDS if b.is_available()]


def backends_for_type(agent_type: str) -> list[Type[AgentBackend]]:
    """Backends whose `agent_type` matches the given orb type. The
    EchoBackend (type 'chat') is always included as a universal
    fallback."""
    by_type = [
        b for b in _BACKENDS if b.is_available() and b.agent_type == agent_type
    ]
    # always offer Echo as a fallback so the dispatcher dropdown is
    # never empty even if a specialized backend has no providers wired
    if EchoBackend not in by_type and EchoBackend.is_available():
        by_type.append(EchoBackend)
    return by_type


def get_backend(backend_id: str) -> Type[AgentBackend] | None:
    for b in _BACKENDS:
        if b.id == backend_id:
            return b
    return None


def default_for_type(agent_type: str) -> Type[AgentBackend]:
    """Best-available backend for a given orb type. Prefers
    specialized non-echo backends, falls back to Echo if none are
    available. Echo is always available so this never returns None."""
    candidates = backends_for_type(agent_type)
    real = [c for c in candidates if c.id != EchoBackend.id]
    if real:
        return real[0]
    return EchoBackend


def list_infos() -> list[BackendInfo]:
    """Dump all backend metadata for the frontend dropdown."""
    return [b.info() for b in _BACKENDS]
