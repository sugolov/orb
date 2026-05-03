# PLAN.md — Ring-Orb Specialization

This is the active plan for moving the system from "every orb is a
generic chat agent" to "ring orbs are specialized agent types with
different orchestrator surfaces." Companion to `ARCH.md` (long-term
roadmap) and `AGENTS.md` (build log of what's actually shipped).

This file gets archived (or replaced) once specialization ships.

---

## The shift

Today: clicking any ring orb opens the same chat-orchestrator panel
(memory column + chat + suborb pills). Every orb is a generic
conversational agent dressed in 3D.

Where we're going: ring orbs come in **types**. Each type has its own
color, its own orchestrator surface, its own toolset, and its own
relationship to suborbs. A code orb opens a terminal-shaped UI; a
research orb opens a chat-with-sources panel; a computer-use orb opens
a screen-stream view. The ring becomes a tool selector for what kind
of agent you want to summon, not just an aesthetic.

Initial type catalog (per the user's spec):

| Type     | Color       | Orchestrator surface         | Has suborbs? |
| -------- | ----------- | ---------------------------- | ------------ |
| chat     | white       | three-column (current panel) | yes          |
| code     | cyan/teal   | terminal + file tree + input | rare/inline  |
| research | amber       | chat + sources panel         | yes (threads)|
| computer | pink        | screen-stream + action log   | no           |
| voice    | violet      | mic-button + transcript      | yes (pinned) |

Plus a "memory" preset on top of the chat type (a chat orb with
personal-data tools wired in).

---

## Architecture: the type-pluggable agent

The single architectural primitive that makes this work: every orb
carries an `agent_type` field, and the system has a registry mapping
each type to:

- a **base color** (drives the shader uniform)
- a **system prompt** (what the agent thinks it is)
- a **toolset** (what it can do)
- a **render mode** (which orchestrator component opens when the user
  clicks into it)
- a **suborb policy** (does it spawn floating suborbs above the panel,
  inline pills only, or none)

The registry is split:

- **Backend registry** (`backend/src/agents/`) — system prompts +
  tools + agent-loop variants. Pluggable per type. Defines what
  agents at this type *do*.
- **Frontend registry** (`frontend/src/agentTypes.ts`) — color, render
  mode, label caption, suborb visibility. Defines what agents at this
  type *look* and *feel* like.

The two registries are kept in sync through the type literal — both
sides import from a shared list `'chat' | 'code' | 'research' | 'computer' | 'voice'`
and exhaustive switches force every type to be handled in every
registry.

---

## Phased plan

### Phase A — Data model + visual differentiation (no behavior change)

The smallest visible step. After this, you can summon a code orb and
see it as a cyan orb in the ring. Clicking it still opens the chat
panel (wrong UX), but you can already see the typed catalog.

**Backend changes:**

- Add to `Orb` model:
  ```python
  agent_type: Literal['chat', 'code', 'research', 'computer', 'voice'] = 'chat'
  agent_config: dict[str, Any] = {}   # type-specific settings, opaque blob
  ```
- `CreateOrb` accepts `agent_type` (default `'chat'`).
- `PatchOrb` accepts `agent_type` so a user can convert a ring orb's
  type post-hoc. (Suborbs inherit; converting a suborb's type is
  forbidden — or it auto-promotes.)
- WS `orb_updated` broadcasts include `agent_type` changes.
- *No agent-loop branching yet.* The system prompt is the same; tools
  are the same. We're shipping the field + the placeholder; behavior
  comes in Phase C.

**Frontend changes:**

- New file `agentTypes.ts` — single source of truth for per-type
  visuals:
  ```ts
  export interface AgentTypeDef {
    id: AgentType;
    label: string;
    color: number;          // hex, used as shader uColor
    workingColor?: number;  // brighter saturated variant
    captionLabel?: string;  // shown under the orb name in 3D
    spawnsSuborbsAbovePanel: boolean;
    rendersInflightInPanel: boolean;
    // future: shader-haze variant, idle-bob amplitude, etc.
  }
  export const AGENT_TYPES: Record<AgentType, AgentTypeDef> = {...};
  ```
- `Orb` interface in `api.ts` gets `agent_type` and `agent_config`.
- `Scene.tsx` `OrbMesh` reads `AGENT_TYPES[orb.agent_type].color`
  instead of using the hardcoded white/purple.
- Status-driven color (working/done/failed) blends with the type's
  color rather than overriding it: `working` bumps brightness/chaos,
  `done` returns to base color.
- Label gets a small caption under the name in the type's color
  (`CHAT`, `CODE`, `RESEARCH`, etc.).
- `Summoner` component is replaced or supplemented by a **type
  picker** — see below.

**Type picker UX (Phase A):**

The center summoner currently spawns a generic 'chat' root. Three
plausible paths:

1. **Six-button radial menu** around the summoner — hover the
   summoner, six small type buttons fan out, click one to spawn that
   type. (Most discoverable, more code.)
2. **Cycle on click** — clicking the summoner cycles through types
   (chat → code → research → computer → voice → chat). Visual
   indicator (color tint of the summoner) shows which type the next
   summon will be. Press space spawns the current selected type.
3. **Seed all types on first run, no picker** — on backend startup,
   if `orbs` is empty, seed five (chat, code, research, computer,
   voice). The user gets all the types immediately on the ring;
   summoner spawns `chat` extras after that. Simplest implementation.

Recommend (3) for Phase A: it's the lowest-friction path to
"specialization is real." Options 1/2 can come later as polish.

**Backend additions for Phase A:**

- On startup (lifespan), if `orbs` is empty, seed the five types as
  ring orbs with appropriate display names and `agent_type`.

**Definition of done for Phase A:**

- [ ] `Orb.agent_type` round-trips through REST and WS.
- [ ] Five distinct ring orbs visible at first load (or after wipe),
      each in its own color.
- [ ] Clicking each one opens the chat panel (same UI for all). This
      is the *known wrong* end state of Phase A — fixed in Phases
      B / C.
- [ ] `agentTypes.ts` is the single source of truth for visuals; no
      hardcoded colors anywhere else in the frontend.

### Phase B — Render-mode dispatch (still no agent behavior change)

Make the orchestrator panel polymorphic. Clicking a `chat` orb opens
the existing `Panel.tsx`; clicking a `code` orb opens a placeholder
`CodeOrchestratorPanel` (just a stub showing "code orchestrator —
not yet implemented" but with the right shell, header, back button).

This is the abstraction step. Once render-mode dispatch exists,
Phase C and beyond just fill in the bodies of each panel.

**Frontend changes:**

- New `OrchestratorPanel.tsx` (or rename Panel) that's a thin router:
  ```tsx
  function OrchestratorPanel(props) {
    switch (props.orb.agent_type) {
      case 'chat':     return <ChatOrchestrator {...props} />;
      case 'code':     return <CodeOrchestrator {...props} />;
      case 'research': return <ResearchOrchestrator {...props} />;
      case 'computer': return <ComputerOrchestrator {...props} />;
      case 'voice':    return <VoiceOrchestrator {...props} />;
    }
  }
  ```
- Each component shares the outer panel shell (border, blur, header,
  back button, transition origin animation). They diverge only in the
  body.
- For Phase B, ChatOrchestrator is the existing `Panel.tsx` content
  extracted; the others are stubs with a placeholder body and a TODO.

**Backend changes:**

- `_build_system_prompt` branches on `agent_type` to produce a
  per-type identity statement. Bodies still go through the same
  `run_agent` loop (single Anthropic stream, no tools), but the
  prompt changes flavor.
- A new helper `agent_definition(orb)` returns a small struct
  `{system_prompt_prefix, tool_names: list[str]}` — Phase B uses only
  the prefix; Phase C adds tools.

**Definition of done for Phase B:**

- [ ] Each agent type opens its own component when entered. Stubs are
      visibly distinct (different placeholder text + accent border).
- [ ] System prompts vary by type (chat agent identifies itself
      differently from a code agent — the model knows it's specialized).
- [ ] All shared infrastructure (transition origin, back button,
      breadcrumb, status pill, panel close) works identically across
      types.

### Phase C — Code orchestrator (full implementation)

Build the code orb out fully. Deepest specialization, biggest payoff.
Once this works the abstraction is proven and the others slot in.

**Backend changes:**

- New module `backend/src/agents/code.py` with:
  - System prompt establishing the agent as a coding assistant.
  - Tools registered with Anthropic:
    - `bash(command, cwd)` — run a shell command in the orb's working
      directory. Returns stdout/stderr/exit_code.
    - `read_file(path)`, `write_file(path, content)`,
      `edit_file(path, old, new)`.
    - `list_dir(path)`.
    - All path operations are sandboxed to `agent_config.working_directory`
      to prevent escape into arbitrary filesystem.
- `run_agent` for code orbs uses an agentic tool-use loop (stream →
  handle tool_use → execute → tool_result → continue).
- New WS event kinds in `RunEvent`: already have `tool_use` and
  `tool_result` placeholders; we now actually emit them.
- `agent_config = {"working_directory": "..."}` set when the user
  creates a code orb. Default to `~/.orb/workspaces/{orb_id}`.

**Frontend changes:**

- `CodeOrchestrator` body:
  - Optional left sidebar: file tree (collapsible).
  - Main pane: terminal-styled output area, monospace, scrolls to
    bottom on new events. Shows tool calls and results inline (`$ ls`,
    output, `[edit] modified foo.py`, etc.).
  - Bottom: instruction input (single-line or auto-growing).
  - No memory column by default — collapsible behind a header button.
- New WS handlers in App for `tool_use` / `tool_result` events.
- `streamStore` logic extended: code orbs accumulate not just text
  but a structured event log per orb id.

**Suborb policy for code orbs:**

- `spawnsSuborbsAbovePanel: false` — code work is mostly linear, we
  don't show floating suborbs above the panel.
- If the agent decides to spawn an internal sub-task (e.g. a "test
  pass"), it appears as a collapsible inline section in the terminal,
  NOT as a floating orb. (This requires a new visual element: an
  "inline child" component.)

**Definition of done for Phase C:**

- [ ] User can summon a code orb, click in, type "create a hello.py
      that prints 'hi'", watch the agent execute via tool calls in
      a terminal-style view, end up with a real file on disk in the
      working directory.
- [ ] Tools are sandboxed: bash + file ops can't escape the working
      directory.
- [ ] AGENTS.md updated with a Step documenting the agent registry
      pattern + the code orb implementation.

### Phase D — Research orchestrator

Two-pane layout, web tools, suborb threads.

**Backend:**

- `agents/research.py` with system prompt for synthesis behavior.
- Tools: `web_search(query)`, `web_fetch(url)`. Use a search API
  (Brave / Exa / Tavily — pick whatever has a clean API).
- The agent emits `tool_use` events; results flow into the sources
  panel.

**Frontend:**

- `ResearchOrchestrator`: chat on left (~60%), sources panel on right
  (~40%). Source cards include URL, snippet, "read" indicator.
- Research-thread suborbs DO appear above the panel (small amber
  orbs). Clicking opens its findings inline.

### Phase E — Computer-use orchestrator

Anthropic's computer-use tools (or a local `pyautogui`/`playwright`
wrapper). Linear, no suborbs.

### Phase F — Voice orchestrator

Whisper.cpp for input, eventually TTS for output. Mic button + transcript.

### Phase G — Type-switching at suborb spawn

After all five types exist, allow heterogeneous trees. Either:

- **Slash commands** in the chat input (`/research X`, `/code X`)
  spawn a typed suborb of a different type than the parent.
- **Agent-driven dispatch** — the agent decides the type when it calls
  `spawn_orb(prompt, type)`.

Start with slash commands (deterministic), graduate to agent-driven
once the system is mature.

---

## Open decisions to resolve early

These need answers before Phase A ships.

### Type-picker UX
- Option (1) radial menu, (2) summoner cycle, (3) seed-on-first-run?
- **Tentative: (3) for Phase A**, then add a picker in Phase A.5 once
  the user wants to spawn additional orbs of specific types.

### Agent-config schema flexibility
- `agent_config` is an opaque `dict` from the backend's perspective.
  Each agent type validates its own config shape.
- Backend should expose a per-type config schema endpoint?
  (`GET /api/agent-types/code/config-schema`) — useful for the UI to
  render type-specific settings.
- **Tentative: deferred**. Hardcode known shapes in the frontend
  registry for now.

### Code orb working-directory choice
- Default to `~/.orb/workspaces/{orb_id}` (sandboxed per-orb).
- Allow user to override via the orb's settings (PATCH `agent_config`).
- Should we let the user point at an existing repo? Probably yes,
  later, with an explicit "trust this directory" gesture.

### Color-status interaction
- Currently `working` bumps an orb to purple. With typed orbs,
  `working` should bump it to its **own working variant** (more
  saturated/brighter version of base color), not generic purple.
- Suborbs of a chat orb still glow purple-while-working today; under
  this model, suborbs inherit parent type, so chat-suborb working
  color stays purple. Code-suborb working color (rare) would be
  brighter cyan. Etc.

### Memory orb
- Spec lists it as `agent_type: 'chat'` with pre-seeded memory and
  extra tools. Not a new type; just a configured chat orb.
- **Defer entirely** until the chat type and at least one tool
  integration ship.

### Phase ordering
- Spec recommends code first because it's most useful + most visually
  different. Agreed.
- Research second — useful + the only one besides code that adds
  meaningful tools.
- Computer-use third — limited by the underlying tool stack
  (computer-use API maturity, sandboxing concerns).
- Voice last — depends on Whisper.cpp integration, separate axis.

---

## Files that need to change (catalogued)

When Phase A ships, these get touched:

**Backend:**
- `backend/src/main.py` — add `agent_type` / `agent_config` fields,
  seed-on-startup logic, broadcast updates.

**Frontend:**
- `frontend/src/api.ts` — `Orb.agent_type`, `AgentType` literal type.
- `frontend/src/agentTypes.ts` — NEW. Visual + UX registry.
- `frontend/src/Scene.tsx` — `OrbMesh` reads color from registry.
- `frontend/src/Summoner.tsx` (split out from Scene.tsx, optional
  refactor) — picker UX.
- `frontend/src/styles.css` — type-tinted UI accents.

When Phase B ships, additionally:

- `frontend/src/OrchestratorPanel.tsx` — NEW. Render-mode router.
- `frontend/src/orchestrators/` — NEW directory. One component per
  type. `ChatOrchestrator.tsx` is the existing `Panel.tsx` content,
  extracted.
- `backend/src/main.py` — `_build_system_prompt` branches on type.

When Phase C ships, additionally:

- `backend/src/agents/code.py` — NEW. Code-agent loop + tools.
- `frontend/src/orchestrators/CodeOrchestrator.tsx` — terminal UI.
- `frontend/src/components/Terminal.tsx` — NEW shared component.

---

## Risks

- **Tool security.** Code orbs running real bash on the user's
  machine is dangerous. Sandbox to a working directory; require an
  explicit "allow this directory" gesture before any path outside the
  default sandbox is touched.
- **API costs.** Tool-use loops can run many model turns per
  interaction. Add visible token-usage indicators per orb in Phase D
  or earlier.
- **Anthropic API ergonomics for tools.** The tool-use loop has
  edge cases (tool errors, context-length blowouts, models that
  refuse to use tools). Phase C should include a fallback mode where
  the model can produce shell commands as text the user runs
  manually, if the tool-use path is unstable.
- **Frontend complexity sprawl.** Five agent-type orchestrators is a
  lot of UI surface. Lean hard on shared shell components (header,
  back button, transition origin) so each orchestrator only owns its
  body.

---

## Done state

Specialization is "done" (PLAN.md retired) when:

1. All five types have working orchestrators (chat / code / research /
   computer / voice).
2. The agent-type registry is the single source of truth on both ends.
3. Type-switching at suborb spawn works (Phase G).
4. The user can demonstrably do work that requires multiple types
   from a single session — e.g., research → save to memory → ask code
   orb to scaffold based on findings.

At that point this file gets rolled into `AGENTS.md` as a multi-Step
"Specialization shipped" section, and `ARCH.md` graduates to the next
big arc (probably persistence + multi-user).
