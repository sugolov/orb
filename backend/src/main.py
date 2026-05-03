"""Orb shell backend.

Single-file backend. In-memory state. See ../../../ARCH.md for the roadmap
and ../../../AGENTS.md for the build log.

Conceptual model
================

Every record in `orbs` is a node in a forest. Two kinds of nodes:

  * orb     — an orchestrator. The user owns this. It holds a chat thread
              and is the place from which sub-tasks are launched. A root
              orb (parent_id is None) is always an orchestrator. A sub-orb
              that's been promoted ("the user clicked into it to chat
              further") functionally also acts as an orchestrator, but
              keeps `kind='suborb'` because that records its origin.

  * suborb  — an agent task executor. Spawned by a chat message in some
              orb (its `parent_id`). Has a `prompt` (the spawning user
              message) and produces a streaming `result`. Its lifecycle
              emits run events the frontend uses to drive animation:
              shader chaos while thinking, fade to white when done, etc.

A suborb that has children of its own is therefore both: a suborb (by
origin) AND an orchestrator (by current role). The data model is
deliberately the same for both because the recursion in this system is
"a suborb can become an orchestrator that spawns its own suborbs."

Run events
==========

When a suborb runs, its agent loop emits a stream of events broadcast
over WS as `{type: "run_event", orb_id, event: {...}}`. Each event has a
`kind`:

  thinking      — emitted at run start; UI may begin a "spinning up"
                  animation. May carry an optional `text` description.
  output_chunk  — a token / text delta from the model. Carries `text`.
  tool_use      — placeholder for v1+ when we register tools. Carries
                  `name` and `input` of the tool the model invoked.
  tool_result   — the result of executing a tool. Carries `output`.
  done          — terminal; final result is in the orb_updated patch.
  error         — terminal; suborb is in `failed` status.

The orb's `status` field is the durable state (idle / working / done /
failed). Run events are the *transient* signals the frontend animates
on. Always treat status as the source of truth; events are for animation
hooks only.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ORB_MODEL = os.environ.get("ORB_MODEL", "claude-opus-4-5")
USER_ID = "me"

# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


OrbKind = Literal["orb", "suborb"]
"""orb = user-summoned orchestrator (root). suborb = agent task spawned
from a parent orb's chat. A suborb you click into still has kind='suborb'
even though it's now also functioning as an orchestrator — kind is
provenance, not current role."""

AgentType = Literal["chat", "code", "research", "computer", "voice"]
"""Five orchestrator types per the ring-orb-specialization spec.

  chat     — generic conversational dispatcher (default for any orb).
  code     — Claude-Code-style: bash + file tools, terminal-style UI.
  research — web search + synthesis, two-pane orchestrator.
  computer — desktop/browser automation (computer-use), screen stream.
  voice    — voice-first, mic + transcript orchestrator.

Each ring orb carries an agent_type that drives:
  - its color (frontend agentTypes.ts registry)
  - its orchestrator UI (frontend OrchestratorPanel router)
  - which backend agents are offered when dispatching (backend
    agents/registry — see Task 4 in overnight.md)

Suborbs inherit their parent's agent_type by default. Type-switching at
spawn happens later (Task 5 in overnight.md / Phase G in PLAN.md)."""

OrbStatus = Literal["idle", "working", "done", "failed"]
"""idle    — fresh orb, no agent has run for it yet (orchestrators).
working — a run is in progress (suborb being executed).
done    — last run finished cleanly; result is populated.
failed  — last run errored; result has the error message."""

RunEventKind = Literal[
    "thinking",
    "output_chunk",
    "tool_use",
    "tool_result",
    "done",
    "error",
]

MemoryKind = Literal["note", "integrated", "context"]
"""note       — manually authored item.
integrated — produced by clicking 'Merge ↑' on a suborb; carries
             prompt + result to the parent's memory. source_orb_id
             records which suborb produced this finding.
context    — auto-derived (e.g. seeded on a ring orb describing what
             the orb is 'about'). Reserved for later phases."""


class Orb(BaseModel):
    """A node in the orb forest. See module docstring for orb vs suborb.

    Tree-as-context: this is the canonical relationship. `parent_id`
    is the only edge that defines context inheritance. Walking from
    any orb up to the root yields its full context chain.
    """

    id: str
    parent_id: str | None = None
    user_id: str = USER_ID
    kind: OrbKind = "orb"
    display_name: str
    # Prompt is set only for suborbs — it's the user message that spawned
    # them. Orchestrators don't have a prompt because they aren't "doing
    # one task" — they're a chat thread that may spawn many tasks.
    prompt: str | None = None
    # Last completion's text, populated when status transitions to done.
    result: str | None = None
    status: OrbStatus = "idle"
    # Pinned suborbs surface a live progress card visible from any view.
    # Persists across navigation; toggled via PATCH /api/orbs/{id}.
    pinned: bool = False
    # Free-form instructions / system-prompt fragment owned by an
    # orchestrator. When a suborb runs, the agent's system prompt
    # includes the ROOT orchestrator's instructions (walk-up). Used to
    # specialize orchestrators (e.g. "you are a calendar assistant —
    # always answer with concrete dates"). Null = generic agent.
    instructions: str | None = None
    # Specialization type. Determines which orchestrator surface opens
    # and which agent backends are offered when dispatching. Suborbs
    # inherit from parent at creation time.
    agent_type: AgentType = "chat"
    # Type-specific config (working_directory for code, viewport for
    # computer-use, etc.). Opaque blob — each agent type validates its
    # own shape. Always serializable as JSON.
    agent_config: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=_now)


class MemoryItem(BaseModel):
    """A piece of context attached to one orb.

    Memory belongs to its owning orb (`orb_id`). Inheritance is computed
    by walking the parent chain — there is no precomputed inheritance
    table. When a suborb's agent runs, its system prompt is built by
    walking parent_id from the suborb up to the root and collecting all
    memory items at each level.

    For 'integrated' items (created via 'Merge ↑'):
      orb_id          = the orchestrator that absorbed the finding
      source_orb_id   = the suborb whose result was merged in
      source_orb_name = cached name (suborb may rename later)
      prompt          = the user's question that produced the finding
      text            = the suborb's result text
    """

    id: str
    orb_id: str
    kind: MemoryKind = "integrated"
    text: str
    prompt: str | None = None
    source_orb_id: str | None = None
    source_orb_name: str | None = None
    created_at: str = Field(default_factory=_now)


class Message(BaseModel):
    """One entry in an orb's chat thread.

    role:
      user   — what the human typed in this orb's chat.
      agent  — final text produced by a suborb's run, mirrored into the
               suborb's own chat for posterity.
      spawn  — marker placed in a parent orb's chat when a suborb was
               spawned from a user message. References spawned_orb_id;
               the UI renders this as the inline expanding pill that
               displays the suborb's streaming + final result.
    """

    id: str
    orb_id: str
    role: Literal["user", "agent", "spawn"]
    content: str | None = None
    spawned_orb_id: str | None = None
    created_at: str = Field(default_factory=_now)


class RunEvent(BaseModel):
    """Transient event emitted during a suborb's run. Drives animation.

    Only `kind` is required; the rest depend on the kind. We send these
    over WS wrapped in `{type: "run_event", orb_id, event: <RunEvent>}`.
    """

    kind: RunEventKind
    text: str | None = None
    name: str | None = None  # for tool_use
    input: dict[str, Any] | None = None  # for tool_use
    output: Any | None = None  # for tool_result
    error: str | None = None  # for error


class CreateOrb(BaseModel):
    display_name: str = "orb"
    # parent_id is intentionally not exposed here — only the chat endpoint
    # creates suborbs. This endpoint creates user-summoned orchestrators.
    agent_type: AgentType = "chat"
    agent_config: dict[str, Any] = Field(default_factory=dict)


class PostMessage(BaseModel):
    content: str


class PatchOrb(BaseModel):
    """Generic orb patch. Only the fields actually present in the request
    body are applied (Pydantic's exclude_unset)."""

    display_name: str | None = None
    pinned: bool | None = None
    # parent_id can be set to null to "promote" a suborb into a root.
    # Set to a string to re-parent it (rarely needed).
    parent_id: str | None = None
    # Orchestrator system-prompt fragment. Setting this on a root orb
    # specializes it (e.g. "you are a calendar assistant"). Suborbs
    # spawned underneath inherit it via the agent's walk-up.
    instructions: str | None = None
    # Convert an orb's specialization type. Mostly used for testing
    # right now; user-facing UI may eventually let users re-type a
    # ring orb (e.g. promote a chat orb into a code orb).
    agent_type: AgentType | None = None
    agent_config: dict[str, Any] | None = None


class CreateMemoryItem(BaseModel):
    text: str
    kind: MemoryKind = "integrated"
    prompt: str | None = None
    source_orb_id: str | None = None
    source_orb_name: str | None = None


class InheritedMemoryItem(BaseModel):
    """Returned by GET /api/orbs/{id}/memory/inherited — a memory item
    enriched with where-it-came-from info for rendering in the UI."""

    item: MemoryItem
    depth: int          # 0 = own; 1 = parent; 2 = grandparent...
    source_name: str    # the orb the item lives on (== ancestor display_name)


# ---------------------------------------------------------------------------
# in-memory store
# ---------------------------------------------------------------------------

orbs: dict[str, Orb] = {}
messages_by_orb: dict[str, list[Message]] = {}
memory_by_orb: dict[str, list[MemoryItem]] = {}
clients: set[WebSocket] = set()


def _label_from_prompt(prompt: str) -> str:
    """Tiny stop-word title generator (1-3 words). Replaceable by a model
    call later (see ARCH.md auto-naming TODO)."""
    stop = {
        "the", "a", "an", "is", "are", "on", "for", "with", "and",
        "or", "to", "in", "of", "about", "at", "by", "my", "me", "i",
        "you", "your", "please", "what", "how", "why", "when", "where",
    }
    tokens = [w.strip(".,!?;:'\"") for w in prompt.split()]
    tokens = [w for w in tokens if w]
    significant = [w for w in tokens if w.lower() not in stop]
    picks = significant[:3] if len(significant) >= 2 else tokens[:3]
    if not picks:
        return "task"
    s = " ".join(w.capitalize() if i == 0 else w.lower() for i, w in enumerate(picks))
    return s[:24]


def _ancestor_chain(orb_id: str) -> list[Orb]:
    """Return [root, ..., parent] for the given orb. Empty list for roots.
    Used for breadcrumbs, memory inheritance, and the agent's context."""
    chain: list[Orb] = []
    cur = orbs.get(orb_id)
    if not cur:
        return chain
    while cur.parent_id:
        parent = orbs.get(cur.parent_id)
        if not parent:
            break
        chain.insert(0, parent)
        cur = parent
    return chain


def _breadcrumb(orb: Orb) -> str:
    """'root_name > parent_name > orb_name' for use in system prompts."""
    chain = _ancestor_chain(orb.id) + [orb]
    parts = [(o.display_name or "unnamed") for o in chain]
    return " > ".join(parts) if parts else "(unknown)"


def _format_inherited_memory(orb_id: str) -> list[str]:
    """Walk the ancestor chain and format every memory item as a single
    line for inclusion in a suborb's system prompt. Order: deepest
    ancestor first (root) → immediate parent. The suborb's *own* memory
    items are not included here — they're separate."""
    out: list[str] = []
    for anc in _ancestor_chain(orb_id):
        for item in memory_by_orb.get(anc.id, []):
            tag = f"[from {anc.display_name or 'unnamed'}]"
            if item.kind == "integrated" and item.prompt:
                out.append(
                    f"{tag} integrated: asked: {item.prompt[:200]} "
                    f"→ answered: {item.text[:300]}"
                )
            else:
                out.append(f"{tag} {item.kind}: {item.text[:300]}")
    return out


def _format_own_memory(orb_id: str) -> list[str]:
    out: list[str] = []
    for item in memory_by_orb.get(orb_id, []):
        if item.kind == "integrated" and item.prompt:
            out.append(
                f"integrated (from sub: {item.source_orb_name or '?'}) — "
                f"asked: {item.prompt[:200]} → answered: {item.text[:300]}"
            )
        else:
            out.append(f"{item.kind}: {item.text[:300]}")
    return out


def _format_chat_history(orb_id: str, max_items: int = 24) -> list[str]:
    """Render an orb's chat thread as readable lines for inclusion in a
    suborb's system prompt. Spawn markers expand to include the
    suborb's name + (truncated) result so a newly-spawned sibling has
    visibility into prior findings.

    The history is implicitly the conversation context: every turn
    (user message / agent message / spawned suborb result) is
    flattened into a single chronological log."""
    msgs = messages_by_orb.get(orb_id, [])
    recent = msgs[-max_items:]
    out: list[str] = []
    for m in recent:
        if m.role == "user" and m.content:
            out.append(f"[user] {m.content[:400]}")
        elif m.role == "agent" and m.content:
            out.append(f"[agent] {m.content[:400]}")
        elif m.role == "spawn" and m.spawned_orb_id:
            sub = orbs.get(m.spawned_orb_id)
            if not sub:
                continue
            name = sub.display_name or "(unnamed)"
            prompt = (sub.prompt or "").strip()
            if sub.result:
                out.append(
                    f"[suborb '{name}'] asked: {prompt[:200]}"
                    f"\n   answered: {sub.result[:400]}"
                )
            elif sub.status == "working":
                out.append(f"[suborb '{name}'] asked: {prompt[:200]} (running)")
            else:
                out.append(f"[suborb '{name}'] ({sub.status})")
    return out


def _build_system_prompt(orb: Orb) -> str:
    """The full agent system prompt for a suborb. Composed of:
      - identity framing (orchestrator name + task statement)
      - the breadcrumb (where this orb sits in the tree)
      - orchestrator instructions (root.instructions, walk-up rule)
      - inherited memory (walk-up over ancestor chain)
      - own memory (this orb's items)
      - output-style guidance

    Tree-as-context: every section here is derived from a fresh walk
    of the parent chain. No precomputed inheritance table.
    """
    breadcrumb = _breadcrumb(orb)
    inherited = _format_inherited_memory(orb.id)
    own = _format_own_memory(orb.id)

    # walk to the root for orchestrator-level context
    chain = _ancestor_chain(orb.id)
    root = chain[0] if chain else orb
    root_name = root.display_name or "orb"

    sections: list[str] = [
        f"You are a suborb spawned by orchestrator '{root_name}'. "
        f"Your job is to handle a focused task within '{root_name}'s "
        "context and return a clear, useful answer the orchestrator can "
        "act on.",
        f"You are at: {breadcrumb}",
    ]

    # collect orchestrator-level instructions from the root downward.
    # Each ancestor on the way down can contribute its `instructions`
    # field — useful when an intermediate suborb has been promoted into
    # a domain-specialized orchestrator and its own descendants inherit
    # those specifics. (Right now only roots have UI to set
    # instructions; this path future-proofs the design.)
    instr_lines: list[str] = []
    for anc in chain:
        if anc.instructions and anc.instructions.strip():
            tag = (
                f"from orchestrator '{anc.display_name}'"
                if anc.parent_id is None
                else f"from intermediate '{anc.display_name}'"
            )
            instr_lines.append(f"[{tag}]\n{anc.instructions.strip()}")
    if instr_lines:
        sections.append(
            "Orchestrator instructions (apply throughout your task):\n\n"
            + "\n\n".join(instr_lines)
        )

    if inherited:
        sections.append(
            "Inherited memory from your ancestors (deepest first):\n"
            + "\n".join(f"  - {line}" for line in inherited)
        )
    if own:
        sections.append(
            "Your own memory:\n"
            + "\n".join(f"  - {line}" for line in own)
        )

    # The orchestrator's full chat history — this is the running
    # conversation that produced this suborb. It includes prior user
    # messages, prior agent replies, AND prior suborbs' prompts +
    # results (rendered inline). Gives this suborb visibility into
    # everything that's been discussed and produced before it,
    # including findings that haven't been explicitly merged into
    # memory yet. The suborb is one moment in this conversation.
    if orb.parent_id:
        parent_history = _format_chat_history(orb.parent_id)
        if parent_history:
            parent = orbs.get(orb.parent_id)
            parent_name = (parent.display_name if parent else None) or root_name
            sections.append(
                f"Conversation history in orchestrator '{parent_name}':\n"
                + "\n".join(f"  {line}" for line in parent_history)
            )

    # Plus this suborb's OWN chat history if it's been chatted with
    # since its initial run (multi-turn continuation). The agent loop
    # passes turns as messages too, but having them here in the system
    # prompt gives the model an explicit summary it can reference.
    own_history = _format_chat_history(orb.id, max_items=12)
    if own_history:
        sections.append(
            "Your own conversation so far:\n"
            + "\n".join(f"  {line}" for line in own_history)
        )

    sections.append(
        "Respond in plain text — concise, direct, under ~200 words "
        "unless the task demands more. No markdown decoration unless "
        "useful. If your task warrants further sub-tasks, mention them "
        "at the end as a brief suggestion (do not attempt to spawn them; "
        "tool support comes later)."
    )
    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# websocket broadcasting
# ---------------------------------------------------------------------------


async def broadcast(event: dict[str, Any]) -> None:
    if not clients:
        return
    payload = json.dumps(event, default=str)
    dead: list[WebSocket] = []
    for ws in list(clients):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def emit_run_event(orb_id: str, event: RunEvent) -> None:
    """Emit a run-event for a suborb. The event is purely transient
    (no persistence); the frontend animates on it."""
    await broadcast(
        {"type": "run_event", "orb_id": orb_id, "event": event.model_dump()}
    )


# ---------------------------------------------------------------------------
# agent runner
# ---------------------------------------------------------------------------

async def run_agent(orb_id: str) -> None:
    """Execute a suborb's agent loop.

    Steps:
      1. Validate the orb exists and is a suborb with a prompt.
      2. Build the system prompt by walking the ancestor chain — this
         is the tree-as-context principle made concrete: the suborb sees
         all memory accumulated by its ancestors.
      3. Emit `thinking` so the frontend can start its animation.
      4. Stream Anthropic completion, broadcasting `output_chunk` events.
      5. On clean finish: persist final text, mirror as an `agent`
         message, transition status to `done`, emit `done` event.
      6. On exception: status `failed`, emit `error` event.

    Without an ANTHROPIC_API_KEY we fall back to a deterministic fake
    stream so the UX is exercisable without an external dependency.
    """
    orb = orbs.get(orb_id)
    if not orb:
        return
    if orb.kind != "suborb" or not orb.prompt:
        # only suborbs run agents; orchestrators are chat threads that
        # spawn suborbs.
        return

    await emit_run_event(orb_id, RunEvent(kind="thinking"))

    if not ANTHROPIC_API_KEY:
        await _run_fake(orb)
        return

    system = _build_system_prompt(orb)
    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    accumulated: list[str] = []

    try:
        async with client.messages.stream(
            model=ORB_MODEL,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": orb.prompt}],
        ) as stream:
            async for text in stream.text_stream:
                accumulated.append(text)
                await emit_run_event(
                    orb_id, RunEvent(kind="output_chunk", text=text)
                )
        result = "".join(accumulated).strip()
        await _finalize_run(orb, result)
    except Exception as e:  # noqa: BLE001
        await _fail_run(orb, str(e))


async def _run_fake(orb: Orb) -> None:
    """Placeholder when no Anthropic key is configured. Streams a canned
    response in word-sized chunks so the animation pipeline is still
    exercised."""
    fake = (
        f'(no ANTHROPIC_API_KEY set — placeholder response for '
        f'"{orb.prompt}")'
    )
    accumulated: list[str] = []
    for chunk in fake.split(" "):
        token = chunk + " "
        accumulated.append(token)
        await emit_run_event(orb.id, RunEvent(kind="output_chunk", text=token))
        await asyncio.sleep(0.04)
    await _finalize_run(orb, "".join(accumulated).strip())


async def run_agent_continue(orb_id: str) -> None:
    """Continue a suborb's existing conversation. Re-runs the agent with
    the suborb's full chat history (multi-turn). The suborb itself
    "answers" — it does NOT spawn a new sub-suborb. This is the path
    used when the user types in a suborb's chat window.

    Conversation shape sent to the model:
      [user]  <orb.prompt>            ← the original spawning prompt
      [assistant] <prior agent reply>
      [user]  <new follow-up>
      ...
    """
    orb = orbs.get(orb_id)
    if not orb or orb.kind != "suborb":
        return

    await emit_run_event(orb_id, RunEvent(kind="thinking"))

    if not ANTHROPIC_API_KEY:
        await _run_fake_continue(orb)
        return

    # Build the message list. The original spawning prompt is in
    # orb.prompt (NOT in the suborb's own messages — it lives in the
    # parent's chat as a `user` message there). We treat it as the
    # implicit first user turn so the model has the full context.
    api_messages: list[dict[str, str]] = []
    if orb.prompt:
        api_messages.append({"role": "user", "content": orb.prompt})
    for m in messages_by_orb.get(orb_id, []):
        if m.role == "user" and m.content:
            api_messages.append({"role": "user", "content": m.content})
        elif m.role == "agent" and m.content:
            api_messages.append({"role": "assistant", "content": m.content})

    system = _build_system_prompt(orb)
    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    accumulated: list[str] = []

    try:
        async with client.messages.stream(
            model=ORB_MODEL,
            max_tokens=1024,
            system=system,
            messages=api_messages,
        ) as stream:
            async for text in stream.text_stream:
                accumulated.append(text)
                await emit_run_event(
                    orb_id, RunEvent(kind="output_chunk", text=text)
                )
        result = "".join(accumulated).strip()

        # Continuation does NOT overwrite orb.result (we keep the FIRST
        # response as the canonical "result"). It also doesn't rename.
        # We just append a new agent message and flip status back to done.
        orb.status = "done"
        agent_msg = Message(
            id=_new_id(), orb_id=orb.id, role="agent", content=result
        )
        messages_by_orb.setdefault(orb.id, []).append(agent_msg)
        await broadcast(
            {"type": "orb_updated", "id": orb.id, "patch": {"status": "done"}}
        )
        await broadcast({"type": "message_added", "message": agent_msg.model_dump()})
        await emit_run_event(orb.id, RunEvent(kind="done", text=result))
    except Exception as e:  # noqa: BLE001
        await _fail_run(orb, str(e))


async def _run_fake_continue(orb: Orb) -> None:
    fake = "(no ANTHROPIC_API_KEY set — placeholder follow-up reply)"
    accumulated: list[str] = []
    for chunk in fake.split(" "):
        token = chunk + " "
        accumulated.append(token)
        await emit_run_event(orb.id, RunEvent(kind="output_chunk", text=token))
        await asyncio.sleep(0.04)
    result = "".join(accumulated).strip()
    orb.status = "done"
    agent_msg = Message(id=_new_id(), orb_id=orb.id, role="agent", content=result)
    messages_by_orb.setdefault(orb.id, []).append(agent_msg)
    await broadcast(
        {"type": "orb_updated", "id": orb.id, "patch": {"status": "done"}}
    )
    await broadcast({"type": "message_added", "message": agent_msg.model_dump()})
    await emit_run_event(orb.id, RunEvent(kind="done", text=result))


async def _finalize_run(orb: Orb, result: str) -> None:
    orb.result = result
    orb.status = "done"
    # If the suborb was spawned with no display_name (the new default —
    # we want it to glow purple unnamed until a result comes back), pick
    # a 1-3 word title now. For v1 this is the stop-word filter; later
    # versions can ask the model.
    if not orb.display_name and orb.prompt:
        orb.display_name = _label_from_prompt(orb.prompt)
    agent_msg = Message(id=_new_id(), orb_id=orb.id, role="agent", content=result)
    messages_by_orb.setdefault(orb.id, []).append(agent_msg)
    await broadcast(
        {
            "type": "orb_updated",
            "id": orb.id,
            "patch": {
                "status": "done",
                "result": result,
                "display_name": orb.display_name,
            },
        }
    )
    await broadcast({"type": "message_added", "message": agent_msg.model_dump()})
    await emit_run_event(orb.id, RunEvent(kind="done", text=result))


async def _fail_run(orb: Orb, error: str) -> None:
    orb.status = "failed"
    orb.result = f"error: {error}"
    await broadcast(
        {
            "type": "orb_updated",
            "id": orb.id,
            "patch": {"status": "failed", "result": orb.result},
        }
    )
    await emit_run_event(orb.id, RunEvent(kind="error", error=error))


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


SEED_ORBS: list[tuple[str, AgentType]] = [
    ("chat", "chat"),
    ("code", "code"),
    ("research", "research"),
    ("computer", "computer"),
    ("voice", "voice"),
    # 'memory' is a chat-typed orb with a personal-data flavor — same
    # surface as chat for now; toolset comes later.
    ("memory", "chat"),
]


def _seed_ring_orbs() -> None:
    """If the in-memory store is empty (first launch / restart), seed
    the typed ring orbs per `RING_ORB_SPECIALIZATION` (mapped here
    from the spec). Each seeded orb is a root with its specialization
    `agent_type`. The frontend's `agentTypes.ts` registry handles the
    visual side (color, label) using only the type literal."""
    if orbs:
        return
    for display_name, agent_type in SEED_ORBS:
        orb = Orb(
            id=_new_id(),
            parent_id=None,
            kind="orb",
            display_name=display_name,
            agent_type=agent_type,
        )
        orbs[orb.id] = orb
        messages_by_orb[orb.id] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    _seed_ring_orbs()
    yield
    # nothing to do on shutdown for v0


app = FastAPI(title="orb-backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": ORB_MODEL,
        "anthropic_configured": bool(ANTHROPIC_API_KEY),
        "orbs": len(orbs),
        "suborbs": sum(1 for o in orbs.values() if o.kind == "suborb"),
    }


@app.get("/api/orbs")
async def list_orbs() -> list[Orb]:
    return list(orbs.values())


@app.post("/api/orbs")
async def create_orb(body: CreateOrb) -> Orb:
    """Create a top-level orchestrator (kind='orb', parent_id=None).

    Suborbs are NOT created via this endpoint — they're spawned by chat
    messages (POST /api/orbs/{id}/messages) so that creation is always
    coupled with the spawning user message and the agent run.
    """
    orb = Orb(
        id=_new_id(),
        parent_id=None,
        kind="orb",
        display_name=body.display_name,
        agent_type=body.agent_type,
        agent_config=body.agent_config,
    )
    orbs[orb.id] = orb
    messages_by_orb[orb.id] = []
    await broadcast({"type": "orb_created", "orb": orb.model_dump()})
    return orb


@app.get("/api/orbs/{orb_id}")
async def get_orb(orb_id: str) -> Orb:
    orb = orbs.get(orb_id)
    if not orb:
        raise HTTPException(404)
    return orb


@app.patch("/api/orbs/{orb_id}")
async def patch_orb(orb_id: str, body: PatchOrb) -> Orb:
    """Generic orb mutation. Used for:
      - pin/unpin       ({pinned: true/false})
      - rename          ({display_name: '...'})
      - promote suborb  ({parent_id: null})  — detaches it into a root.
      - re-parent       ({parent_id: '...'}) — rare; cycle-checked.

    Only fields explicitly present in the request body are applied.
    """
    orb = orbs.get(orb_id)
    if not orb:
        raise HTTPException(404)

    patch = body.model_dump(exclude_unset=True)

    # Cycle check on parent_id changes — never allow an orb to become
    # an ancestor of itself.
    if "parent_id" in patch:
        new_parent = patch["parent_id"]
        if new_parent is not None:
            if new_parent == orb_id:
                raise HTTPException(400, "cannot parent an orb to itself")
            if new_parent not in orbs:
                raise HTTPException(400, "parent_id refers to unknown orb")
            # walk up new_parent's chain; if we hit orb_id, it's a cycle
            cursor: str | None = new_parent
            seen = set()
            while cursor and cursor not in seen:
                if cursor == orb_id:
                    raise HTTPException(400, "would create a cycle")
                seen.add(cursor)
                anc = orbs.get(cursor)
                cursor = anc.parent_id if anc else None

    for k, v in patch.items():
        setattr(orb, k, v)

    await broadcast({"type": "orb_updated", "id": orb_id, "patch": patch})
    return orb


@app.delete("/api/orbs/{orb_id}")
async def delete_orb(orb_id: str) -> dict[str, str]:
    """Soft-delete this orb plus all descendants. Cascades to messages
    and memory items belonging to any deleted orb."""
    if orb_id not in orbs:
        raise HTTPException(404)
    to_kill = {orb_id}
    queue = [orb_id]
    while queue:
        cur = queue.pop()
        for o in orbs.values():
            if o.parent_id == cur and o.id not in to_kill:
                to_kill.add(o.id)
                queue.append(o.id)
    for oid in to_kill:
        orbs.pop(oid, None)
        messages_by_orb.pop(oid, None)
        memory_by_orb.pop(oid, None)
        await broadcast({"type": "orb_deleted", "id": oid})
    return {"deleted": "ok"}


# ---------------------------------------------------------------------------
# memory endpoints
# ---------------------------------------------------------------------------


@app.get("/api/orbs/{orb_id}/memory")
async def list_memory(orb_id: str) -> list[MemoryItem]:
    """Memory items owned by this orb (not inherited from ancestors)."""
    if orb_id not in orbs:
        raise HTTPException(404)
    return memory_by_orb.get(orb_id, [])


@app.get("/api/orbs/{orb_id}/memory/inherited")
async def inherited_memory(orb_id: str) -> list[InheritedMemoryItem]:
    """Walk the ancestor chain and return each ancestor's memory items
    tagged with depth (1 = parent, 2 = grandparent, ...). The orb's own
    items are NOT included here — query /memory for those. Order goes
    from oldest ancestor (root) to immediate parent so the UI can render
    from broadest scope to most-specific."""
    if orb_id not in orbs:
        raise HTTPException(404)
    out: list[InheritedMemoryItem] = []
    chain = _ancestor_chain(orb_id)
    # depth: root = len(chain); immediate parent = 1
    for idx, anc in enumerate(chain):
        depth = len(chain) - idx
        for item in memory_by_orb.get(anc.id, []):
            out.append(
                InheritedMemoryItem(
                    item=item,
                    depth=depth,
                    source_name=anc.display_name or "unnamed",
                )
            )
    return out


@app.post("/api/orbs/{orb_id}/memory")
async def add_memory(orb_id: str, body: CreateMemoryItem) -> MemoryItem:
    """Add a new memory item to this orb. The frontend's 'Merge ↑'
    action posts here against the suborb's parent, with the suborb as
    source_orb_id and its prompt+result as the body."""
    if orb_id not in orbs:
        raise HTTPException(404)
    item = MemoryItem(
        id=_new_id(),
        orb_id=orb_id,
        kind=body.kind,
        text=body.text,
        prompt=body.prompt,
        source_orb_id=body.source_orb_id,
        source_orb_name=body.source_orb_name,
    )
    memory_by_orb.setdefault(orb_id, []).append(item)
    await broadcast({"type": "memory_added", "item": item.model_dump()})
    return item


@app.get("/api/orbs/{orb_id}/messages")
async def list_messages(orb_id: str) -> list[Message]:
    if orb_id not in orbs:
        raise HTTPException(404)
    return messages_by_orb.get(orb_id, [])


@app.post("/api/orbs/{orb_id}/messages")
async def post_message(orb_id: str, body: PostMessage) -> dict[str, str | None]:
    """A user typed a message in orb_id's chat.

    Two paths depending on the orb's role:

      • Orchestrator (kind='orb', incl. suborbs promoted to root):
        Spawn a NEW SUBORB as a child of orb_id with the user's text
        as its `prompt`. Insert a `spawn` marker in this orb's chat;
        the UI renders it as a pill that opens the suborb's window.

      • Suborb (kind='suborb'):
        Append the user's message to the suborb's OWN chat and re-run
        the agent on the SAME orb with the full conversation. The
        suborb is the executor/answerer — it does NOT spawn another
        nested suborb. This is the multi-turn chat path.

    Returns: `{suborb_id: <id> | null}` — id of the freshly-spawned
    suborb (orchestrator path) or `null` (continuation path).
    """
    parent = orbs.get(orb_id)
    if not parent:
        raise HTTPException(404)

    content = body.content.strip()
    if not content:
        raise HTTPException(400, "empty message")

    # always: append the user message to this orb's chat
    user_msg = Message(id=_new_id(), orb_id=orb_id, role="user", content=content)
    messages_by_orb.setdefault(orb_id, []).append(user_msg)
    await broadcast({"type": "message_added", "message": user_msg.model_dump()})

    if parent.kind == "suborb":
        # continuation path — re-run the agent on this same suborb
        parent.status = "working"
        await broadcast(
            {"type": "orb_updated", "id": orb_id, "patch": {"status": "working"}}
        )
        asyncio.create_task(run_agent_continue(orb_id))
        return {"suborb_id": None}

    # orchestrator path — spawn a fresh suborb whose prompt is the user's
    # text. display_name left empty until _finalize_run picks one.
    # Suborbs inherit their parent's agent_type unless explicitly
    # overridden (Phase G / Task 5: type-switching at spawn).
    suborb = Orb(
        id=_new_id(),
        parent_id=orb_id,
        kind="suborb",
        display_name="",
        prompt=content,
        status="working",
        agent_type=parent.agent_type,
        agent_config=dict(parent.agent_config),
    )
    orbs[suborb.id] = suborb
    messages_by_orb[suborb.id] = []
    await broadcast({"type": "orb_created", "orb": suborb.model_dump()})

    # spawn marker in the orchestrator's chat — this is the pill in the
    # UI; clicking it opens the suborb's chat window.
    spawn_msg = Message(
        id=_new_id(),
        orb_id=orb_id,
        role="spawn",
        spawned_orb_id=suborb.id,
    )
    messages_by_orb[orb_id].append(spawn_msg)
    await broadcast({"type": "message_added", "message": spawn_msg.model_dump()})

    # fire and forget the initial run
    asyncio.create_task(run_agent(suborb.id))

    return {"suborb_id": suborb.id}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    clients.add(websocket)
    try:
        # send current state on connect so a fresh frontend can hydrate
        # without an extra REST round-trip.
        await websocket.send_text(
            json.dumps(
                {
                    "type": "snapshot",
                    "orbs": [o.model_dump() for o in orbs.values()],
                    "messages": {
                        oid: [m.model_dump() for m in msgs]
                        for oid, msgs in messages_by_orb.items()
                    },
                    "memory": {
                        oid: [m.model_dump() for m in items]
                        for oid, items in memory_by_orb.items()
                    },
                },
                default=str,
            )
        )
        while True:
            # we don't expect client messages yet; reading just so we
            # notice disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)


def run() -> None:
    """Boot uvicorn against this module. Useful as `python src/main.py`
    from inside `backend/`."""
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )


if __name__ == "__main__":
    run()
