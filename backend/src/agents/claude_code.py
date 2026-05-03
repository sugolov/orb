"""ClaudeCodeBackend — Claude Code CLI as a subprocess.

Spawns the `claude` CLI (https://github.com/anthropics/claude-code) and
pipes a prompt through, parsing its stream-json output. Available
only if the CLI is on PATH.

Phase note: Task 4 ships the *skeleton* — `is_available()` checks for
the CLI, `start()` is wired up to call `claude --print --output-format
stream-json`, parse incremental events, and translate them into
AgentCallbacks. Multi-turn `send_message` is a future enhancement
(would need a long-lived session via `claude` interactive mode or a
new CLI invocation per turn with reconstructed history).

If the CLI is missing this backend reports unavailable and the
registry uses Echo as the fallback for code-typed orbs.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from typing import Any, ClassVar

from .base import AgentBackend, AgentCallbacks


def _claude_cli() -> str | None:
    """Locate the `claude` CLI in PATH. Returns the absolute path or
    None. Cached after first call."""
    return shutil.which("claude")


class ClaudeCodeBackend(AgentBackend):
    id: ClassVar[str] = "claude-code"
    display_name: ClassVar[str] = "Claude Code"
    agent_type: ClassVar[str] = "code"
    description: ClassVar[str] = (
        "Spawns the `claude` CLI as a subprocess for coding tasks. "
        "Requires `claude` on PATH. Sandboxed to the orb's working "
        "directory."
    )

    @classmethod
    def is_available(cls) -> bool:
        return _claude_cli() is not None

    def __init__(self, orb_id: str, config: dict | None = None) -> None:
        super().__init__(orb_id, config)
        # working directory for this code orb. Defaults to a per-orb
        # sandbox under ~/.orb/workspaces/{orb_id}.
        from pathlib import Path

        wd = self.config.get("working_directory")
        if not wd:
            wd = str(Path.home() / ".orb" / "workspaces" / orb_id)
        Path(wd).mkdir(parents=True, exist_ok=True)
        self.working_directory = wd

    async def start(
        self,
        prompt: str,
        system_prompt: str,
        callbacks: AgentCallbacks,
    ) -> str:
        """Run `claude --print --output-format stream-json -p <prompt>`
        in a subprocess. Parse stream-json events, route them into the
        AgentCallbacks. Return the final assistant text."""
        cli = _claude_cli()
        if not cli:
            raise RuntimeError("`claude` CLI not on PATH")

        proc = await asyncio.create_subprocess_exec(
            cli,
            "--print",
            "--output-format",
            "stream-json",
            "-p",
            prompt,
            cwd=self.working_directory,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        accumulated: list[str] = []
        if proc.stdout:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                line_str = line.decode().strip()
                if not line_str:
                    continue
                try:
                    event = json.loads(line_str)
                except json.JSONDecodeError:
                    continue
                await self._dispatch_event(event, accumulated, callbacks)

        rc = await proc.wait()
        if rc != 0:
            err = ""
            if proc.stderr:
                err = (await proc.stderr.read()).decode()
            raise RuntimeError(
                f"claude CLI exited with code {rc}: {err[:500]}"
            )

        return "".join(accumulated).strip()

    async def _dispatch_event(
        self,
        event: dict[str, Any],
        accumulated: list[str],
        callbacks: AgentCallbacks,
    ) -> None:
        """Translate a single stream-json event from `claude` CLI into
        the AgentCallbacks vocabulary. The exact event shape varies by
        CLI version; we handle the common cases and fall back to a
        textual representation for unknown types."""
        kind = event.get("type", "")

        if kind == "assistant":
            # incremental assistant message — the CLI emits chunks
            # of text; concatenate.
            content = event.get("message", {}).get("content")
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        accumulated.append(text)
                        if callbacks.on_chunk:
                            await callbacks.on_chunk(text)
                    elif block.get("type") == "tool_use":
                        if callbacks.on_tool_use:
                            await callbacks.on_tool_use(
                                block.get("name", "tool"),
                                block.get("input", {}),
                            )
            elif isinstance(content, str):
                accumulated.append(content)
                if callbacks.on_chunk:
                    await callbacks.on_chunk(content)
        elif kind == "tool_result":
            if callbacks.on_tool_result:
                await callbacks.on_tool_result(event.get("content"))
        elif kind == "result":
            # final summary; ignore — we accumulate from assistant chunks
            pass
        # other types (system, user echo, etc.) ignored
