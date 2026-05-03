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


