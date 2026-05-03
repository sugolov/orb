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


