# ARCH.md — Orb Roadmap

This is the live project roadmap. `AGENTS.md` is the build log
(comprehensive record of what's actually shipped, including all design
iterations); this file is the path forward.

When `ARCH.md` and `AGENTS.md` conflict, **AGENTS.md wins** — it's
reality, this file is plan.

The unit of progress is a numbered version. Each version ships
something visibly working end-to-end. Re-evaluate after each.

---

## Where we are right now (`v0`–`v1.x`)

A user can:

1. Open the app to a black canvas with a wavy "fire orb" summoner at
   center. A floating instructions icon at bottom-left explains
   gestures.
2. Press space or click the summoner → a root orb (orchestrator)
   appears in a ring at the top, animating outward from origin.
3. Click an orb → spatial-zoom orchestrator panel opens. The other
   ring orbs scale to 0; cloud overlay parts in a clearing; camera
   parallax dampens.
4. Type in the panel chat → a sub-orb spawns above the panel and the
   model's response streams live (real Claude Opus via Anthropic
   API). The sub-orb glows purple while working, fades to white when
   done. The response is automatically labeled.
5. Click a sub-orb → a floating chat window opens *centered on the
   orb's screen position*. The window is draggable (header) and
   resizable (corner).
6. Type in the suborb's window → continues that suborb's
   conversation (multi-turn; the suborb itself answers; does NOT
   spawn further).
7. Click `⇈ promote` → suborb detaches into a root orb (it can
   then spawn its own suborbs as a full orchestrator).
8. Click `↑ merge` → saves the suborb's prompt+result into the
   orchestrator's memory. The next suborb spawned in that
   orchestrator inherits the finding via the system-prompt walk-up.
9. Click `pin` → in ring view, this suborb appears as a small
   summary card anchored top-left of its root orb (matches
   `images/image copy.png` mockup), with status + feed lines. Click
   the card → re-enters the orchestrator with the chat window
   re-mounted.
10. Right-click any orb → delete (cascades to descendants).
11. The OrbChart in the top-right shows the live tree. Roots are
    clickable; suborbs are inert (promote first to make clickable).

What's wired:

- Backend: single-file FastAPI (`backend/src/main.py`), in-memory
  store, REST + WebSocket. Real Anthropic streaming with
  `python-dotenv` for the API key. Falls back to a placeholder
  stream when no key.
- Frontend: Vite + React + TS + react-three-fiber. Custom GLSL
  shader for orbs. Floating chat windows with full drag/resize/pin/
  merge/promote/close. Orb chart, info menu, pinned summary cards.
- Two-orb-role model (orb / suborb); tree-as-context with live
  walk-up for memory inheritance.

What's NOT shipped (the rest of this file):

- Agent-driven fan-out (`spawn_orb` tool).
- Real tool integrations (calendar, mail, file search).
- JSON snapshot persistence — backend restart = wiped state.
- Per-orb model override.
- Multi-user (`user_id` is hardcoded `"me"`).
- 3D pinned-orb dot visualization in ring view.
- Wheel-resize / double-click-rename gestures.
- Auto-naming via the model.

---

## Core mental model (definitive — also captured in `AGENTS.md` Step 10)

**Two orb roles:**

| Role     | Created by                                  | Visual                | Chat behavior                       | Pinnable? |
| -------- | ------------------------------------------- | --------------------- | ----------------------------------- | --------- |
| **orb** (root) | user clicks summoner / spacebar       | orchestrator panel    | typing → spawns a suborb (child)    | No        |
| **suborb**     | parent orchestrator's chat (or `spawn_orb` later) | floating chat window  | typing → continues this suborb's convo | Yes       |

**Promotion**: `PATCH /api/orbs/{id}` with `parent_id: null` makes a
suborb into a root (cycle-checked). Descendants travel with it.

**Tree-as-context**: `parent_id` is the only edge. Memory belongs to
its owning orb; inheritance is computed live by walking up the tree.
Every agent invocation builds its system prompt from a fresh walk-up,
no caching.

**Merge ↑**: a suborb's prompt+result is copied into its parent's
memory as an `integrated` MemoryItem with `source_orb_id` set. Future
suborbs spawned in the parent inherit this finding automatically.

**Pinning**: a suborb-only flag. Its only effects are:
1. Show a summary card anchored to the root orb in ring view.
2. Auto-include the chat window in the agent-view render set when the
   user re-enters the matching root (window state is reset on each
   view change since they unmount).

Pinning does NOT keep the chat window open across views, and does NOT
work on root orbs.

**Spatial zoom**: panel grows out of the clicked orb's pixel position
(cubic-bezier overshoot, 400ms). Ring orbs scale to 0; cloud overlay
parts via shader; camera parallax dampens — all keyed off a shared
`viewT` ref that lerps between 0 (ring) and 1 (agent).

---

## v2 — agent fan-out (`spawn_orb` tool)

**Why:** today recursion only happens when the user types in a root's
chat. The defining behavior of an "OS for LLMs" is that agents
themselves decompose work. The `spawn_orb` tool unlocks that.

**Scope:**

- Define the Anthropic tool:

  ```json
  {
    "name": "spawn_orb",
    "description": "Spawn a sub-orb to handle a focused sub-task...",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": { "type": "string" },
        "name":   { "type": "string", "description": "optional 1-3 word title" }
      },
      "required": ["prompt"]
    }
  }
  ```

- Replace the v1 `messages.stream(...)` call with a proper agentic
  loop: stream → handle `tool_use` blocks → execute → append
  `tool_result` → continue. Loop until no more tools.
- A `spawn_orb` call from inside `run_agent` creates a child of the
  *currently-running* orb (NOT the user's currently-focused
  orchestrator). Important so an agent at depth 4 spawns into depth 5.
- Insert a `spawn` marker in the parent's chat (same shape as the
  user-driven path); the UI's pill rendering already handles it.
- Hard caps: `MAX_DEPTH = 4`, `MAX_CHILDREN_PER_ORB = 8`. When
  exceeded, return `{error: "depth limit reached"}` so the agent can
  adapt.

**Important interaction with current model:** v1 disabled the "suborb
spawns from typing in suborb chat" recursion to make suborbs pure
executors. The `spawn_orb` tool restores fan-out but at the agent's
discretion — it's still NOT triggered by typing in a suborb chat
window (which remains a multi-turn continuation with the same suborb).
Only the agent's tool calls fan out.

**Observable change:** type "research three indie games released last
year and tell me what's notable about each" — the orchestrator's
suborb runs and itself spawns three more sub-suborbs in parallel via
tool calls. They appear as nested pills inside the suborb's window
*in addition to* the slot-row visualization.

**Definition of done:**

- [ ] `spawn_orb` tool registered; agentic loop handles tool_use → tool_result.
- [ ] A single user prompt can produce ≥1 agent-spawned sub-suborbs.
- [ ] Depth + sibling caps enforced and surfaced as a clean error to the agent.
- [ ] The pinned-summary card shows nested suborb activity correctly.
- [ ] AGENTS.md updated with a new Step.

---

## v3 — JSON snapshot persistence

**Why:** restarting the backend wipes everything. We're going to be
running this every day; that's intolerable.

**Scope:**

- FastAPI `lifespan`:
  - On startup: read `~/.orb/state.json` (or `./.orb-state.json`) if
    it exists; populate `orbs`, `messages_by_orb`, `memory_by_orb`.
  - On shutdown: serialize the same and write atomically (tmp +
    rename).
- Periodic auto-save (every 60s, or every Nth mutation — whichever is
  first).
- `POST /api/snapshot` for explicit save (handy during dev).

**What's not persisted:** in-flight `run_event` chunks / partial
streams; the transient `openWindowIds`. If the server dies mid-stream,
on next startup mark all `working` orbs as `failed` with result
`"interrupted by restart"`.

**Definition of done:**

- [ ] Restart-safe. The user's tree, messages, and memory survive
      `kill` + re-`uvicorn`.
- [ ] AGENTS.md updated.

---

## v4 — interaction polish (drag / resize / rename)

**Why:** the prototype's UX has more 3D gestures than we currently
expose. Bringing them back on top of the real backend.

**Scope:**

- **Drag orbs in 3D**: `pointermove` past 4px threshold; reproject
  mouse onto the orb's z-plane. Persist as `base_pos` via
  `PATCH /api/orbs/{id}`.
- **Wheel-resize** a hovered orb. Persist `user_scale`.
- **Double-click rename**: inline input anchored to the orb's screen
  position. PATCH `display_name` + `user_renamed=true` so the
  auto-namer never overwrites.
- **3D pinned-suborb dots**: pinned suborbs render as tiny scale-0.30
  dots orbiting their root in ring view (the prototype's pattern).
  Adds a 3D representation of "this suborb has live activity"
  alongside the summary card.

**Definition of done:**

- [ ] Drag / resize / rename / 3D pinned dots all wired.
- [ ] Persisted via PATCH; survives restart (after v3).
- [ ] AGENTS.md updated.

---

## v5 — per-orb model selection

**Why:** different orbs serve different jobs. Some are reasoning-heavy
(opus). Some are summary pumps (haiku). The system should be
indifferent to which model lives at each node.

**Scope:**

- Add `Orb.model: str | None`. None means "inherit from parent".
- `resolve_model(orb)`: walks parent chain; first non-null wins;
  ultimate fallback is `ORB_MODEL` env var.
- Frontend: small dropdown in the orchestrator panel header AND in
  the suborb chat window header. Hardcoded list to start (opus,
  sonnet, haiku, inherit). PATCH on change.
- `/health` reports the available list.

**Definition of done:**

- [ ] Per-orb model resolves correctly across the inheritance chain.
- [ ] UI dropdown changes the model the next run uses.
- [ ] AGENTS.md updated.

---

## v6 — first real tool: calendar (or whichever domain you pick first)

**Why:** the system gets interesting when agents can read your actual
data. Until then it's still a toy chat tree.

**Scope:**

- Pick one integration. Calendar is the easiest demo (read-only to
  start).
- Wire `calendar_list`, `calendar_search` as Anthropic tools. Gate
  per orb based on root display name (e.g. only orbs whose root is
  named "calendar" get them — first time the "different roots have
  different toolsets" idea becomes real).
- Tool-use events surface in the SuborbWindow's live stream area
  with a different formatting (already supported by the structured
  `RunEvent` schema).

**Definition of done:**

- [ ] At least one tool that hits a real data source.
- [ ] An orb whose root is "calendar" can answer "what's on my
      schedule tomorrow" with real data.
- [ ] AGENTS.md updated.

---

## v7+ — beyond MVP (parking lot)

Things that are real ambitions but not yet scheduled. Pulled forward
as needed.

- **SQLite migration.** When JSON snapshots get unwieldy or we want
  proper queries (memory full-text search, time-range filters,
  run-event history). Schema sketch already in this file's older
  revisions and in `AGENTS.md`.
- **Auth + multi-user.** `user_id` columns are already in the schema
  as `"me"`. Drop in Clerk / Supabase Auth / your own JWT layer.
- **Auto-naming via the model.** Replace the stop-word
  `_label_from_prompt` with a cheap haiku call given prompt +
  result. Background-update via PATCH.
- **Auto-summarization for merge.** Replace the slice-first-240-chars
  with a model-summarized memory item.
- **Run event log retention.** Today `run_event`s are transient. To
  replay an agent's reasoning later, persist them (lives well in
  SQLite).
- **Voice input.** Whisper.cpp local; pipe transcripts into the chat
  input.
- **Eye-tracking parallax.** WebGazer.js to drive `camera.position`
  instead of mouse.
- **Tauri packaging.** Bundle backend + frontend into a desktop app.
  End-state vision is a NixOS module that boots into the shell.
- **WS backpressure.** With many parallel agents we may flood the
  client; batch chunks server-side at high rates.
- **Run cancellation.** `DELETE /api/orbs/{id}/runs/current` to abort
  the Anthropic stream and mark the orb failed cleanly.
- **Drag-to-merge gesture.** Drag a suborb chat window onto another
  orb to merge memory contextually (alternative to the merge button).
- **Orchestrator-level memory column.** Bring back the prototype's
  panel memory column showing inherited + own items in one scrolling
  list. Currently the memory column is in Panel.tsx but only renders
  inherited items derived from the ancestor chain. With v2's spawn-
  orb tool feeding in more memory, this column gets richer.

---

## Working principles

These guide what goes in vs. what gets deferred.

1. **Each version must work end-to-end.** No "we'll wire this up
   later" commits. If it's in, it's connected.
2. **Backend stays in one file as long as humanly possible.** Splitting
   `main.py` is a tax that pays off only when there's structural
   pressure. We're nowhere near that (~750 lines is fine).
3. **Frontend introduces structure incrementally.** No Zustand, no
   Tailwind, no router until we feel the pain.
4. **`AGENTS.md` updated after every numbered version.** Build log is
   the permanent record of what's actually shipped, in detail. Skim
   before designing the next version.
5. **`ARCH.md` is the roadmap; `AGENTS.md` is reality.** When they
   conflict, AGENTS.md wins.
6. **No hidden persistence formats.** Whatever we serialize is human-
   readable JSON until we explicitly migrate to SQLite.
7. **Streaming is the default visual.** Every long-running operation
   shows incremental output.
8. **Refs over state for per-frame data.** `viewT`, screen positions,
   drag offsets all live in refs. State is for things that should
   trigger re-renders.
9. **Optimistic local updates** for actions that round-trip via
   backend (pin/unpin, delete, etc.). The WS broadcast confirms; the
   local update keeps the UI responsive.
10. **The tree IS the context graph.** Don't query memory by orb_id
    directly; always walk the tree. Same in backend `run_agent` and
    frontend `gatherMemory`.

---

## Operating notes (current)

```sh
# terminal 1 — backend
cd backend
cp .env.example .env             # paste your ANTHROPIC_API_KEY
uv venv
uv pip install -r <(uv pip compile pyproject.toml)
.venv/bin/uvicorn --app-dir src main:app --reload --host 127.0.0.1 --port 8000

# terminal 2 — frontend
cd frontend
npm install
npm run dev
```

Visit <http://localhost:5173>.

Without an API key the backend serves a deterministic placeholder
stream so the full UX is exercisable offline.
