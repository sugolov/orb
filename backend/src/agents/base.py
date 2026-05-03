"""Pluggable agent backend interface.

A backend is the **how** behind an orb's "what". Per the overnight.md
spec, any backend that conforms to this interface is wireable as an
option for spawning sub-orbs.

A backend instance is created when an orb begins running and lives as
long as the orb does (so follow-up messages route to the same instance,
preserving any in-process state — subprocess handles, conversation
history, model context, etc.).

The lifecycle:
    backend = SomeBackend(orb_id, config)
    await backend.start(prompt, system_prompt, callbacks)   # initial run
    await backend.send_message(text, system_prompt, callbacks)  # follow-ups
    ...
    await backend.stop()                                       # cleanup

Events flow back via `AgentCallbacks` — every callback is async and
optional. The runner wraps these to broadcast WS `run_event` payloads
of the matching kind.

Subclasses should override:
    id, display_name, agent_type, description, color  (class-level metadata)
    is_available()      — return False if env can't run this backend
    start()             — required; perform the first run
    send_message()      — optional; required for conversational backends
    stop()              — optional; cleanup
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, ClassVar

# Forward-declared in main.py; keep loosely typed to avoid circular import.
AgentType = str


@dataclass
class AgentCallbacks:
    """Event sink. The runner provides instances of these that broadcast
    over the WebSocket. All callbacks are async; all are optional. A
    backend that doesn't use a particular event simply doesn't call it.

    on_thinking()       — emitted at run start so the UI can begin a
                          spin-up animation.
    on_chunk(text)      — text delta from the model. Append to UI stream.
    on_tool_use(name, input)
                        — model invoked a tool. Surface in the UI's
                          terminal-style output for code orbs etc.
    on_tool_result(out) — result of executing a tool.
    on_done(result)     — final completion text. Backend may emit this
                          itself OR rely on the runner emitting it from
                          the return value of start()/send_message().
    on_error(message)   — fatal error during the run.
    """

    on_thinking: Callable[[], Awaitable[None]] | None = None
    on_chunk: Callable[[str], Awaitable[None]] | None = None
    on_tool_use: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None
    on_tool_result: Callable[[Any], Awaitable[None]] | None = None
    on_done: Callable[[str], Awaitable[None]] | None = None
    on_error: Callable[[str], Awaitable[None]] | None = None


@dataclass
class BackendInfo:
    """Metadata exposed to the frontend for the agent dropdown."""

    id: str
    display_name: str
    agent_type: str
    description: str
    available: bool


class AgentBackend(ABC):
    """Per-orb agent instance. One per running orb id."""

    # Class-level metadata. Override in subclasses.
    id: ClassVar[str] = "abstract"
    display_name: ClassVar[str] = "Abstract"
    agent_type: ClassVar[AgentType] = "chat"
    description: ClassVar[str] = ""

    @classmethod
    def is_available(cls) -> bool:
        """Return True if this backend can actually run in the current
        environment (api keys present, CLIs installed, etc.). Returns
        True by default — override for backends with external deps."""
        return True

    @classmethod
    def info(cls) -> BackendInfo:
        return BackendInfo(
            id=cls.id,
            display_name=cls.display_name,
            agent_type=cls.agent_type,
            description=cls.description,
            available=cls.is_available(),
        )

    def __init__(self, orb_id: str, config: dict[str, Any] | None = None) -> None:
        self.orb_id = orb_id
        self.config: dict[str, Any] = config or {}

    @abstractmethod
    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        """Begin the agent. Stream events via callbacks. Return the
        final text result. Runner handles persisting + broadcasting
        the result; the backend just needs to produce it."""
        ...

    async def send_message(
        self,
        content: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        """Continue the conversation. Default: not supported.

        Conversational backends (chat-style) override this to keep
        their message history and re-stream a response. Linear
        backends (e.g. computer-use, voice) may not implement this
        and let the runner re-create the backend per turn instead.
        """
        raise NotImplementedError(
            f"{self.id} does not support follow-up messages"
        )

    async def stop(self) -> None:
        """Cleanup any resources (subprocesses, sessions, sockets).
        Default: noop."""
        return None
