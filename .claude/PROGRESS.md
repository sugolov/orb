# Overnight Progress Log

Branch: `overnight`. Tasks defined in `overnight.md`. After each task commit
this gets a status entry.

## Notes on adaptation

`overnight.md` is written assuming the prototype's vanilla-JS architecture
(`userData.agentType`, `setTimeout` placeholders, JS classes). The actual
codebase is **Python FastAPI backend + React/TS/R3F frontend**. I'm
mapping the spec's intent to our stack:

- "userData.agentType" → `Orb.agent_type` field on the backend pydantic
  model, mirrored on the frontend `Orb` interface.
- "ORCHESTRATOR_SURFACES registry" → frontend `agentTypes.ts` registry
  for visuals + `OrchestratorPanel.tsx` router that dispatches on
  `orb.agent_type` to per-type React components.
- "AgentBackend class with start/sendMessage/stop" → Python
  `backend/src/agents/` module with a base class + concrete backends.
- "subprocess for `claude` CLI" → Python `asyncio.subprocess` instead of
  Node's `child_process`.

The data model + UX semantics from the spec are followed exactly.

## Status entries

(prepended below as tasks complete)

### Task 8 — sub-orb-centric polish ✓

- SuborbWindow header dot uses orb's agent_type color (idle/done);
  working state keeps purple pulse for universal "thinking" signal.
- SuborbWindow left border uses --type-accent CSS variable for
  type identity at a glance.
- Panel background slightly more transparent (0.78 → 0.62) so the
  3D scene reads as foreground.
- Hover tooltip on orb labels (type + prompt + first line of
  result). Native title= for now.
- Trace clean.

### Task 7 — real backend wiring (verified, partial) ✓

Wired and live (already from Task 4):
- `echo` — always available, deterministic stream for testing.
- `claude-chat` — Anthropic Messages API streaming. Available iff
  `ANTHROPIC_API_KEY` env var is set (loaded via `python-dotenv`
  from `backend/.env`). System prompt assembled fresh each turn
  from the orb's tree-as-context walk; per-instance message history
  preserves multi-turn continuation.
- `claude-code` — spawns the `claude` CLI as a subprocess with
  `--print --output-format stream-json`. Parses incremental JSON
  events into AgentCallbacks (assistant text → on_chunk; tool_use
  blocks → on_tool_use; tool_result blocks → on_tool_result).
  Sandboxed to `~/.orb/workspaces/{orb_id}` per code orb.

BLOCKED:
- `claude-research` — requires a web-search provider integration.
  Options to unblock: (a) Anthropic's web_search beta tool (when
  generally available); (b) Brave Search API (`BRAVE_API_KEY`);
  (c) Exa (`EXA_API_KEY`); (d) Tavily (`TAVILY_API_KEY`). Backend
  reports `is_available() == False`; registry routes research-orb
  dispatches to `echo` as fallback.
- `claude-computer` — requires significant infra: virtual display
  / screen capture (e.g. xvfb + screenshot pipeline), input
  injection (pyautogui / playwright), action recording. Likely
  needs a Docker container or VM. Out of scope for an overnight
  pass. Backend reports unavailable.

Followups not addressed but worth noting:
- ClaudeCodeBackend doesn't yet implement `send_message` (multi-turn
  continuation). Each follow-up via the runner falls through to
  `start()` which spawns a fresh CLI subprocess. Working directory
  is preserved across calls, so persistent state on disk carries
  over, but in-memory CLI session does not. Real fix: hold a
  long-lived `claude` interactive process and pipe new prompts in.
- ClaudeChatBackend keeps its own message history per instance; the
  orchestrator's chat history (parent's chat) is included via the
  system prompt walk-up. This is consistent with the spec's
  ARCHITECTURE.md §4.5 pattern.

### Task 6 — code orchestrator surface ✓

- `CodeOrchestrator` is a real terminal-style scrollback. Each
  dispatched sub-orb is a collapsible CodeBlock; inside it tool_use
  / tool_result events render as `$ name {input}` + indented pre
  output. Falls back to plain text stream for backends without tool
  events (echo).
- `Scene.tsx` checks `agent_type.spawnsSuborbsAbovePanel`: code orb
  sub-orbs render inline in the terminal, NOT as floating 3D orbs.
- New `.code-*` styles in styles.css; cyan/sky theme.
- Default backend for code orbs: `claude-code` via registry, with
  echo fallback when CLI missing.
- Trace clean.

### Task 5 — backend events into sub-orb visuals ✓

- App's `runEvents: Map<orb_id, RunEvent[]>` captures tool_use /
  tool_result / error / done events. Reset on `thinking`.
- Tool events ALSO get a textual annotation in `streams` so chat-
  style surfaces (no terminal renderer) still display something
  when tools fire.
- `OrchestratorProps.runEvents` plumbed through; CodeOrchestrator
  (Task 6) uses it for terminal rendering.
- Most of Task 5 was already satisfied by Task 4 (real backends,
  state transitions, instance caching, deletion teardown).
- Trace clean.

### Task 4 — backend agent registry + pluggable backends ✓

- `backend/src/agents/` new module with `base.AgentBackend` + 5
  concrete backends (echo, claude-chat, claude-code, claude-research
  stub, claude-computer stub) and a registry.
- `run_agent`/`run_agent_continue` rewritten as thin runners over
  the registry. Backend instances cached per orb id in `agents_by_orb`
  so follow-ups keep their context.
- `delete_orb` now stops the backend (subprocess teardown).
- New `GET /api/agent-backends` for the frontend dropdown.
- BLOCKED: `claude-research` (needs a web search provider — Brave/Exa/
  Tavily/Anthropic search-tool — none wired). `claude-computer`
  (needs screenshot+input infra; deferred).
- Trace clean — echo + claude-chat round-trip via the new path.

### Task 3 — orchestrator reframed as dispatcher ✓

- Center column of the orchestrator panel is now a dispatch log: one
  card per sub-orb spawned at this level. Card carries type-tinted
  border, status dot, prompt, optional live stream preview, type
  label.
- Built from the existing message stream: each `spawn` marker is
  paired with the immediately-preceding `user` message to form a
  card. Lonely user/agent messages are skipped (orchestrators don't
  have their own chat thread anymore).
- No backend change required — backend already wasn't appending
  agent-side messages to the orchestrator chat.
- Trace clean: click → empty log → dispatch task → card appears →
  click card → chat window → pin → ring view → re-enter → log intact.

### Task 2 — typed ring orbs + per-type color ✓

- Backend `_seed_ring_orbs()` runs at lifespan startup; seeds the six
  typed ring orbs (chat / code / research / computer / voice / memory)
  if the store is empty.
- `Scene.OrbMesh.targetColor` now reads `AGENT_TYPES[orb.agent_type]`
  for both base and working colors. Hex→THREE.Color cache avoids
  per-frame allocations.
- Visual: ring shows 6 distinctly colored orbs. Click on a non-chat
  orb still opens the chat surface (stub fallthrough) — per the spec
  this is the intended Task-2 end state.
- Trace: works for all six orbs.

### Task 1 — pluggable orchestrator surface + agent_type ✓

- Backend: `AgentType` literal added; `Orb`/`CreateOrb`/`PatchOrb` carry
  `agent_type` (default `'chat'`) and `agent_config` (empty dict).
  Suborbs inherit parent's `agent_type` at spawn (`post_message`).
- Frontend: `agentTypes.ts` is the visual registry (color / working
  color / suborb policy / css accent). `OrchestratorPanel.tsx` routes
  on `orb.agent_type`. `Panel.tsx` is a re-export shim so App stays
  untouched. `Code/Research/Computer/Voice` orchestrators are stubs
  that fall through to `ChatOrchestrator` for now.
- Type-check passes; backend imports clean.
- Trace: click chat orb → orchestrator opens (same body as before, now
  via `ChatOrchestrator`) → spawn suborb → click → chat window → pin →
  back to ring → re-enter. All preserved because chat orbs remain the
  default and the routing is structurally identical.


