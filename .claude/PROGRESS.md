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


