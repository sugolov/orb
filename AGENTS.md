# AGENTS.md — Orb Build Log

This file is a running, detailed log of what's been built, why, and how the
pieces fit together. It is updated after every major step. Treat it as the
source of truth for the live system state — `ARCH.md` is the forward
roadmap; this is what actually exists right now.

Repo layout (as of latest entry):

```
orb/
├── ARCH.md            # forward roadmap (v0 done, v1+ scoped)
├── README.md          # one-liner
├── AGENTS.md          # this file — append-only build log
├── orb-shell.html     # original prototype, untouched (visual + UX reference)
├── images/            # design imagery
├── backend/           # FastAPI + Anthropic streaming, in-memory
│   ├── pyproject.toml         # deps only — no package, no console script
│   ├── .env.example
│   ├── README.md
│   └── src/
│       └── main.py            # the entire backend, single file
└── frontend/          # Vite + React + TS + R3F
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── orb-shell.html         # legacy copy, reference only
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── Scene.tsx
        ├── orbShader.ts
        ├── Panel.tsx
        ├── api.ts
        └── styles.css
```

---

## Step 1 — Backend (`backend/`)

### Goal

A single-file FastAPI app that:

1. Stores orbs and chat messages in memory.
2. Exposes a tiny REST surface to create root orbs and post chat messages.
3. Streams Anthropic responses back over a single broadcast WebSocket.
4. Spawns a child orb (the "agent task executor") for every chat message
   posted to a parent orb (the "orchestrator").

No tools, no recursion, no persistence, no auth. Anything more belongs in
later versions (see `ARCH.md`).

### What's installed

`backend/pyproject.toml` declares:

```toml
dependencies = [
  "fastapi>=0.110",
  "uvicorn[standard]>=0.27",
  "anthropic>=0.40",
  "websockets>=12",
  "pydantic>=2.6",
  "python-dotenv>=1.0",
]
```

Installed via `uv` into `backend/.venv`. There is no Python package; the
backend runs as a flat module, so the pyproject has no `[build-system]`
or `[project.scripts]` block. Install with:

```sh
uv venv
uv pip install -r <(uv pip compile pyproject.toml)
```

The original scaffold listed `aiosqlite>=0.20`. It's been removed because
v0 has no persistence (state lives in module-level dicts; lost on process
exit). It will come back in v4.

### Environment

`backend/.env.example` (copy to `.env` and fill in):

```
ANTHROPIC_API_KEY=
ORB_MODEL=claude-opus-4-5
```

`python-dotenv` loads this at import time. If `ANTHROPIC_API_KEY` is unset
the server still works — it falls back to a placeholder fake-stream so the
end-to-end UX is testable without an API key.

### Data model

Two Pydantic types (kept intentionally lean):

```python
class Orb(BaseModel):
    id: str                    # 12-hex-char uuid
    parent_id: str | None      # None for roots
    user_id: str = "me"
    display_name: str
    prompt: str | None         # None for user-created roots; set on sub-orbs
    result: str | None         # final agent response once status=='done'
    status: 'idle' | 'working' | 'done' | 'failed'
    created_at: ISO8601 string

class Message(BaseModel):
    id: str
    orb_id: str                # which orb's chat thread this belongs to
    role: 'user' | 'agent' | 'spawn'
    content: str | None        # for user/agent messages
    spawned_orb_id: str | None # for spawn markers; references the child orb
    created_at: ISO8601 string
```

Three roles of message:

- `user` — what the human typed.
- `agent` — what the model produced (final, after streaming completes).
- `spawn` — placeholder marker that says "a sub-orb was spawned here";
  references `spawned_orb_id`. This is what becomes the inline expanding
  pill in the UI.

### State

All state is module-level globals in `backend/src/main.py`:

```python
orbs: dict[str, Orb]               # id -> orb
messages_by_orb: dict[str, list[Message]]  # orb_id -> ordered messages
clients: set[WebSocket]            # all open WebSocket connections
```

Lost on process restart — by design, this is v0.

### REST endpoints

- `GET /health` — liveness; also reports configured model + whether
  Anthropic is wired in.
- `GET /api/orbs` — flat list of every orb. Frontend builds the tree client-side.
- `POST /api/orbs` — body `{display_name, parent_id?}`; creates an orb,
  inserts it into state, broadcasts `orb_created` over WS. Used by the UI's
  "press space to summon" gesture (always creates a root with `parent_id=null`).
- `GET /api/orbs/{id}` — single orb fetch.
- `DELETE /api/orbs/{id}` — soft-delete the orb plus all descendants
  (recursively walks `parent_id`). Broadcasts `orb_deleted` per id.
- `GET /api/orbs/{id}/messages` — chat history for that orb.
- `POST /api/orbs/{id}/messages` — **the chat endpoint**. Body `{content}`.
  This is the heart of v0:
    1. Append a `user` message to the orb's chat.
    2. Create a new sub-orb with `parent_id=id`, `prompt=content`,
       `status='working'`. Display name auto-generated by stop-word filter.
    3. Append a `spawn` message to the parent's chat referencing the
       new child.
    4. `asyncio.create_task(run_agent(child.id))` — fire-and-forget.
    5. Return `{child_id}` immediately (streaming happens via WS).

Every state mutation broadcasts the corresponding event over WS so the
frontend never has to refetch.

### WebSocket protocol

`WS /ws` — push-only from server to client (in v0 the client never sends
anything; we read incoming messages just to detect disconnects).

On connect, the server immediately sends a `snapshot` event with the full
current state so a fresh frontend can hydrate without any other HTTP calls
beyond the initial `GET /api/orbs`. (We do both — REST hydrate + WS snapshot
— for redundancy. Either alone would work.)

Event envelope:

```json
{ "type": "snapshot",     "orbs": [...], "messages": {...} }
{ "type": "orb_created",  "orb": {...} }
{ "type": "orb_updated",  "id": "...", "patch": {...} }
{ "type": "orb_deleted",  "id": "..." }
{ "type": "message_added","message": {...} }
{ "type": "run_event",    "orb_id": "...", "chunk": "..." }
{ "type": "run_finished", "orb_id": "...", "result": "..." | "error": "..." }
```

`broadcast()` iterates `clients`, removes any that error out. No
backpressure handling yet.

### The agent runner — `run_agent(orb_id)`

The whole reason this app exists. Steps:

1. Look up the orb. Sanity check `orb.prompt` is set.
2. **If `ANTHROPIC_API_KEY` is unset**: produce a fake space-separated
   placeholder stream (40ms per word) so the UI flow can be exercised
   without a real key. Useful for pure UX dev.
3. Otherwise, open `AsyncAnthropic(...).messages.stream(...)` with:
   - `model = ORB_MODEL` (env-driven)
   - `max_tokens = 1024`
   - `system = SYSTEM_PROMPT`
   - `messages = [{"role": "user", "content": orb.prompt}]`
   - **No tools** in v0.
4. Iterate `stream.text_stream` (helpful Anthropic SDK helper that gives
   plain text deltas). For each chunk:
   - Append to an in-memory accumulator.
   - Broadcast `{type: "run_event", orb_id, chunk}` over WS.
5. When the stream finishes:
   - `orb.result = accumulated_text`
   - `orb.status = "done"`
   - Append a final `agent` message into the orb's own chat history.
   - Broadcast `orb_updated` (status + result) and `run_finished`.
6. On exception: `orb.status = "failed"`, `orb.result = "error: ..."`,
   broadcast.

Two important properties:

- Fire-and-forget: the HTTP request that spawned this returns immediately
  with `{child_id}`. The frontend learns about progress purely through WS.
  This means a slow model never blocks the request thread.
- Streaming chunks land directly on every connected client — no buffering,
  no queueing, no per-orb subscriber list. With one user there's exactly
  one connection so this is fine; later versions may need filtering.

### System prompt (v0)

```
You are an orb — one agent in a recursive agent OS where every node is a
long-lived agent. The user has spawned you to handle one focused task.
Respond directly and concisely in plain text. No markdown decoration unless
useful. Aim for under ~200 words.
```

Dead simple. No memory, no tools, no breadcrumb. Those come in v1–v2.

### CORS

`fastapi.middleware.cors.CORSMiddleware` permits `http://localhost:5173` and
`http://127.0.0.1:5173` (the Vite dev server's two hostnames). Required
because the frontend makes cross-origin requests in dev. In production we'd
serve the frontend from the same origin and drop this.

### Booting

```sh
cd backend
cp .env.example .env  # add your key (optional)
uv venv
uv pip install -r <(uv pip compile pyproject.toml)
.venv/bin/uvicorn --app-dir src main:app --reload --host 127.0.0.1 --port 8000
# or:
.venv/bin/python src/main.py
```

`--app-dir src` prepends `backend/src/` to `sys.path` so uvicorn can resolve
the bare `main:app` import. Without it you'd need to `cd src` first.

---

## Step 2 — Frontend (`frontend/`)

### Goal

Replace the prototype `orb-shell.html`'s "fake setTimeout result" placeholder
with a real React app that:

1. Talks to the v0 backend over REST + WebSocket.
2. Renders orbs in a 3D scene using react-three-fiber, with the original
   prototype's GLSL shader ported over.
3. Shows an orchestrator panel when an orb is selected, with chat history,
   a text input, and inline streaming "spawn pills" for sub-orbs.
4. Visually mirrors the prototype's vibe — orbs go purple+lightning while
   the agent thinks, then white when the result is done.

### Stack

```
react           18.3
react-dom       18.3
three           0.169
@react-three/fiber  8.17
@react-three/drei   9.114
typescript      5.6
vite            5.4
```

No Zustand, no Tailwind, no router. v0 sticks to `useState` and a single
`styles.css`. Structure gets introduced when we feel the pain.

### Vite config

`frontend/vite.config.ts`:

```ts
server: {
  port: 5173,
  proxy: {
    '/api':    'http://127.0.0.1:8000',
    '/ws':     { target: 'ws://127.0.0.1:8000', ws: true },
    '/health': 'http://127.0.0.1:8000',
  },
}
```

So in dev the frontend can call `/api/orbs` and `new WebSocket('ws://localhost:5173/ws')`
without thinking about CORS or hostnames.

### File responsibilities

#### `src/main.tsx`

Renders `<App />` into `#root`, imports `./styles.css`. Standard.

#### `src/api.ts`

Tiny typed REST client + WebSocket hook.

Exports:

- `Orb`, `Message`, `OrbStatus` TypeScript types — mirror the backend
  Pydantic models exactly.
- `ServerEvent` discriminated union — one shape per WS event type.
- `listOrbs()`, `createOrb(name, parent_id?)`, `deleteOrb(id)`,
  `sendMessage(orbId, content)` — typed wrappers around `fetch`.
- `useWS(onEvent)` — React hook. Opens a single WebSocket to `/ws`, wires
  `onmessage` to parse JSON and call the latest `onEvent` handler.
  Auto-reconnects with an 800ms delay if the socket closes (handles
  backend restarts during dev). Holds the handler in a `useRef` so the
  hook itself only mounts once per component lifetime — prevents reconnect
  storms when state changes upstream.

#### `src/orbShader.ts`

Two GLSL strings — `orbVert`, `orbFrag` — direct port of the inline shader
from `orb-shell.html`. Uniforms:

- `uTime: float` — seconds since scene start; drives the haze/noise.
- `uIntensity: float` — overall brightness multiplier; ramps during work.
- `uColor: vec3` — base color (purple while working, white when done, red on failure).
- `uChaos: float` (0..1) — when > 0, layers a multi-octave noise + strobe
  + bolt effect on top to produce the "lightning" working-orb look.

Otherwise identical to the prototype: vertex pass writes view dir + local
pos; fragment combines fresnel rim with two octaves of value noise for the
haze, additive-blended.

#### `src/Scene.tsx`

The R3F scene.

- `<Canvas>` from `@react-three/fiber` with antialias, opaque black bg, a
  single perspective camera at `[0, 0, 9]`. `style={{position:'fixed', inset:0}}`
  so it covers the whole viewport.
- `ScenePosLayout` (helper inside the Canvas) decides what's visible:
  - **Roots** (parent_id == null): all of them, laid out on a ring whose
    radius scales with N (preserving a constant inter-orb chord). Math
    ported verbatim from `orb-shell.html`'s `ringRadius` / `ringPosForIndex`.
  - **Sub-orbs of the current orb**: rendered in a slot row at y=1.7,
    with order [0, -1, 1, -2, 2, ...] so they spread out from center
    above the orchestrator panel. Same heuristic as the prototype.
  - Sub-orbs of orbs that aren't currently focused: hidden in v0.
    (Visible-pinned-orb cascade comes in v3.)
- `OrbMesh` (per-orb component):
  - `<mesh>` with a `<sphereGeometry>` (radius 0.55, 64×64) and a
    `<shaderMaterial>` referencing the ported GLSL.
  - Memoised uniforms object (so the shader doesn't recreate every render).
  - `useFrame((_, dt) => ...)` runs every animation frame:
    - Lerps `group.position` toward the prop-driven target with a small
      sine bob, so position changes ease in instead of snapping.
    - Updates `uTime`.
    - Lerps `uColor` toward `targetColor(orb.status)` (purple/red/white).
    - Pushes `uChaos` toward 1.0 while working, 0.0 otherwise (smoothed).
    - Drives `uIntensity` with shimmer + occasional spikes while working,
      gentle breathing when done.
    - Bumps scale by ~10% if this orb is the current orchestrator.
  - `<Html>` from drei renders the orb's display_name as a DOM element
    anchored just below the mesh. `pointerEvents="none"` so it never
    intercepts clicks. Class `working` adds a purple tint while busy.
  - Click handler calls `onClick(orb)` (lifted to App).

#### `src/Panel.tsx`

The orchestrator panel — DOM, not 3D. Slides up over the scene whenever
`App` has a `currentOrb`.

Props: the orb being orchestrated, its messages, an `orbsById` lookup map
(needed to resolve `spawn.spawned_orb_id`), the live `streams` map (orb_id
→ partial text being streamed in for that orb), an `onClose`, and an
`onEnterSubOrb` for clicking finished sub-orb pills.

Renders:

- **Header**: `← Back` button, breadcrumb (`messages › Yo › Hello` style,
  built by walking `parent_id` upward through `orbsById`), and a status
  pill that pulses purple when the orb has any sub-orb working.
- **Messages list**: scrollable, auto-scrolled to bottom on new messages
  or new stream chunks.
  - `user` → white bubble right-aligned.
  - `agent` → dark bubble left-aligned.
  - `spawn` → a "spawn pill". This is the most interesting render branch:
    - Looks up the referenced sub-orb in `orbsById`.
    - If that sub-orb is `working`: shows the partial text from `streams`
      under the pill header in real time (CSS `white-space: pre-wrap`).
    - If `done`: shows the final `result`, becomes clickable; clicking
      calls `onEnterSubOrb`.
    - If `failed`: shows the error result with a red dot.
  - Empty-state hint when a freshly-created root has no messages.
- **Input row**: single text input. Enter triggers `sendMessage(orb.id, text)`.
  Disabled briefly during the round-trip to prevent double-submit.

#### `src/App.tsx`

The single source of state.

```tsx
const [orbs,    setOrbs]    = useState<Map<string, Orb>>(new Map());
const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
const [streams, setStreams] = useState<Map<string, string>>(new Map());
const [currentOrbId, setCurrentOrbId] = useState<string | null>(null);
```

Three Maps because we want O(1) lookup by id everywhere. The orbs Map's
values are also iterated to drive the scene; cheap enough at our scale.

Effects:

1. On mount: `listOrbs()` REST call hydrates `orbs`. (Redundant with the
   WS `snapshot` event but covers the edge case where REST resolves first.)
2. `useWS(onEvent)` opens a WebSocket and dispatches every event:
   - `snapshot` → replace `orbs` and `messages` with the server's view.
   - `orb_created` → upsert the orb, ensure an empty messages list.
   - `orb_updated` → shallow-merge the patch into the existing orb.
   - `orb_deleted` → remove from orbs/messages/streams.
   - `message_added` → append to that orb's message list.
   - `run_event` → append the chunk to the streams map for that orb.
   - `run_finished` → no-op (we already get final state via `orb_updated`;
     keeping the partial stream lying around is harmless and lets the UI
     keep showing progressive text until the final replaces it).
3. Window-level `keydown`: spacebar (when no input focused) calls
   `createOrb('orb')` to summon a new root. Escape closes the panel.

Rendering:

- `<Scene>` always present.
- A `.hint` overlay shows either "press space to summon" (zero orbs)
  or "click an orb to enter · press space for another" (some orbs but no
  panel open).
- `<Panel>` appears when `currentOrb !== null`.
- `handleSelect(orb)`: opens the panel for that orb, but only if it's not
  in `working` status (clicking a half-formed agent does nothing yet).

#### `src/styles.css`

Cherry-picked from `orb-shell.html`'s CSS — only the parts we still use:

- Reset + fullscreen `body`.
- `.orb-label` (3D HTML label, including the purple `.working` variant).
- `.hint` overlay.
- `.panel` + `.panel-header` + `.hbtn` + breadcrumb.
- `.panel-status` (with the `.busy` purple variant + pulse keyframes).
- `.messages` + `.msg.user|agent|agent.dim` bubbles + `msgIn` keyframes.
- `.spawn` + `.spawn.done` + `.spawn.failed` pill with header, dot,
  status, and inline `.spawn-text` for the streaming response.
- `.input-row` chat input.

Result panel, tree, drag overlays, progress cards, rename input — all
dropped. They come back when their version ships.

### v0 boot test results

Verified end-to-end via the real WebSocket + REST flow:

- Backend boots clean: `GET /health` → `{"status":"ok","model":"claude-opus-4-5","anthropic_configured":false,"orbs":0}`.
- Vite dev server boots clean and proxies `/api`, `/ws`, `/health` to `:8000`.
- WS opens through the Vite proxy and immediately sends a `snapshot` event.
- `POST /api/orbs/{id}/messages` triggers the full broadcast sequence
  (`message_added` → `orb_created` → `message_added (spawn)` →
  `orb_updated (status=done)` → `run_finished`) with the placeholder
  fake-stream when no API key is configured.
- TypeScript strict mode passes (`tsc --noEmit` is clean).

---

## Step 3 — Backend layout cleanup

### Why

The original scaffold used a `src/orb_backend/` Python package with a
`pyproject.toml` build-system + `[project.scripts]` console script. For a
single-file backend this is overkill: the indirection forced us to write
`uvicorn orb_backend.main:app`, the `__init__.py` exists only to declare
`__version__`, and `uv pip install -e .` installs an empty package.

We're nowhere near needing a Python package boundary. The whole backend
fits in one file, and there's no second module to import it from.

### Change

Flattened to:

```
backend/
├── pyproject.toml      # deps only (no [build-system], no [project.scripts])
├── .env.example
├── README.md
└── src/
    └── main.py         # the entire backend
```

Concretely:

- `mv backend/src/orb_backend/main.py backend/src/main.py`
- `rm -rf backend/src/orb_backend/` (deleted `__init__.py`)
- Edited `pyproject.toml`: removed `[build-system]`,
  `[tool.hatch.build.targets.wheel]`, and `[project.scripts] orb-backend = ...`.
  Kept `[project]` (deps) and `[tool.ruff]` / `[tool.pytest]`.
- Edited `main.py`'s `run()` helper: `"orb_backend.main:app"` → `"main:app"`.
- Recreated `.venv` from scratch (`rm -rf .venv && uv venv`) and reinstalled
  via `uv pip install -r <(uv pip compile pyproject.toml)`.

### Run command (new)

```sh
.venv/bin/uvicorn --app-dir src main:app --reload --host 127.0.0.1 --port 8000
```

`--app-dir src` prepends the directory to `sys.path` so the bare module
import resolves. Without it you'd have to `cd src` first.

Verified: `GET /health` and `POST /api/orbs` both return 200 against the
new layout. No behavior changes, just a smaller footprint.

### Docs cascade

- `backend/README.md` updated with new install + run instructions.
- `ARCH.md` "Operating notes" section updated.
- This file (`AGENTS.md`) updated above (layout map at top + this Step 3).

---

## Step 4 — `PLAN.md` consolidated into `ARCH.md`

The previous build had two separate documents: `ARCH.md` (long-horizon
spec, Claude's original 637-line write-up) and `PLAN.md` (concrete
versioned roadmap that came after v0 shipped).

Two docs covering forward-looking design is one too many. The original
`ARCH.md` is also no longer accurate — half its premises (SQLite from day
one, the `Run.events` table, the user_id column scheme) describe an
imagined future, while half describe components that v0 actually
implements differently.

Replaced `ARCH.md` with the contents of `PLAN.md` (numbered versions,
working principles, operating notes). Deleted `PLAN.md`. From here on:

- `ARCH.md` = forward roadmap (what's next).
- `AGENTS.md` = build log (what exists).
- `orb-shell.html` = visual + UX reference.

If they conflict, `AGENTS.md` wins.

---

## Step 5 — Backend: explicit `kind` + structured run events

User direction: "make sure you make the backend follow this design,
anticipate orb and suborb. orb is like an orchestrator and suborb is an
agent that will produce outputs and throw things to animate later."

### Conceptual change

The data model now distinguishes two roles by an explicit `kind` field:

- **`kind: 'orb'`** — an orchestrator. User-summoned, no `prompt`. Has
  a chat thread that spawns suborbs.
- **`kind: 'suborb'`** — an agent task executor. Spawned by a chat
  message, has a `prompt`, runs an agent loop, produces a `result`.

A suborb can be clicked into and continue chatting (effectively
becoming an orchestrator too), but `kind` records its origin and never
changes after creation. The recursion in this system is "a suborb can
*also act* as an orchestrator that spawns its own suborbs" — same
record, different role at different times.

### Run events (animation hooks)

`run_event` over WS now carries a structured event object instead of a
raw chunk:

```json
{ "type": "run_event", "orb_id": "...", "event": {
    "kind": "thinking" | "output_chunk" | "tool_use" | "tool_result"
          | "done" | "error",
    "text": "...",      // output_chunk, done
    "name": "...",      // tool_use
    "input": {...},     // tool_use
    "output": ...,      // tool_result
    "error": "..."      // error
  }}
```

A suborb's run lifecycle now emits:
1. `thinking` at run start — UI may begin a "spinning up" animation.
2. `output_chunk` for each text delta as before.
3. `done` (with final text) or `error` at termination.

The orb's durable `status` (idle/working/done/failed) is still the
source of truth for state. Run events are *transient* signals the
frontend animates on. `tool_use` / `tool_result` are reserved for v1
when the `spawn_orb` tool ships.

### Layout cleanup (also Step 5)

Backend layout flattened from `backend/src/orb_backend/main.py` to
`backend/src/main.py`. No package, no console script, no `[build-system]`
in pyproject — just deps. Run with
`.venv/bin/uvicorn --app-dir src main:app --reload`.

---

## Step 6 — Spatial-zoom UI ("orb becomes orchestrator")

The user provided a detailed spec describing the central UX trick of
the system: **clicking a top-level orb does not "open a menu". The orb
itself becomes the orchestrator.** The panel grows out of the clicked
orb's pixel position; the rest of the ring fades to scale 0; the cloud
overlay parts in a circular clearing; the camera stops drifting. On
exit, the panel collapses back into the orb.

### Phase machine (App.tsx)

```ts
type Phase = 'idle' | 'closing' | 'transitioning';
```

- `idle` — panel sits at center (or unmounted if no `currentOrbId`).
- `closing` — panel collapsing back to `transitionOrigin`; will unmount
  afterward and lerp viewT 1 → 0 (back to ring view).
- `transitioning` — panel collapsing, content swap, re-expand. viewT
  stays at 1 because we're moving between orchestrators (recurse into
  a sub-orb, or back up one level), NOT exiting agent view.

Transition duration: `PANEL_TRANSITION_MS = 400` (CSS keeps the same
`0.4s` value). A tighter feel than the original 650ms.

### State driving the zoom

```ts
const [currentOrbId, setCurrentOrbId] = useState<string | null>(null);
const [transitionOrigin, setTransitionOrigin] = useState<ScreenPos | null>(null);
const [phase, setPhase] = useState<Phase>('idle');
const inAgentView = currentOrbId !== null && phase !== 'closing';
```

`inAgentView` is what Scene.tsx watches to lerp `viewT` toward 1 or 0.
During a `transitioning` phase, `inAgentView` stays true so viewT stays
at 1 — the cloud doesn't close, ring orbs don't reappear; only the
panel collapses and re-expands.

### Scene.tsx — `viewT` ref drives every animation

A single `useRef<number>` initialised to 0 lives at the Canvas level.
A `<ViewTLerp>` component inside the Canvas runs each frame:

```ts
viewT.current += ((inAgentView ? 1 : 0) - viewT.current) * Math.min(1, dt * 4);
```

Every animated thing keys off this ref:

- **Ring orbs**: visScale = `1 - smoothstep(0.05, 0.6, viewT)`.
- **Sub-orbs of currentOrb**: visScale = `smoothstep(0.4, 0.95, viewT)`.
- **Cloud overlay**: shader uniform `uViewState = smoothstep(0.05, 0.85, viewT)`,
  used in `centerMask` to open a circular clearing.
- **Camera parallax**: `parallaxMod = 1 - viewT`, multiplied into the
  mouse-driven camera offset (so the scene goes still in agent view).
- **Summoner**: visScale = `1 - smoothstep(0.05, 0.6, viewT)` (only in
  ring view).

`viewT` is a ref (not state) because it changes every frame — using
state would trigger React re-renders 60 times a second. The ref is
read inside each component's `useFrame` callback.

### Cloud overlay (`<CloudOverlay>`)

A 20×20 plane rendered with the FBM noise shader from `orb-shell.html`,
positioned each frame 2 units in front of the camera and aligned with
the camera's quaternion (camera-attached overlay). `uViewState` carves
out a circular clearing centered on UV (0.5, 0.55) when in agent view.

### Camera parallax (`<CameraParallax>`)

Mouse position lives in a window-level ref in App, updated by a
`pointermove` listener. CameraParallax reads it each frame and lerps
`camera.position` toward `mouseRef.current.x * 0.25 * parallaxMod`,
`mouseRef.current.y * 0.15 * parallaxMod`. `camera.lookAt(0,0,0)` keeps
the look target stable.

### Panel (Panel.tsx)

Position-driven CSS transitions. The component renders with inline
`left/top/transform/opacity` styles that depend on `isOpen = mounted && phase === 'idle'`:

- `isOpen=true`: `left: 50%, top: calc(50% + 90px), transform: translate(-50%, -50%) scale(1), opacity: 1`.
- `isOpen=false`: at `transitionOrigin` pixel coords, scale 0.05, opacity 0.

A double-rAF on mount flips `mounted` to true so the browser commits
the initial (collapsed) style before the transition picks up the swap
to centered/scaled.

CSS rule:
```css
transition:
  left 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
  top 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
  transform 0.4s cubic-bezier(0.34, 1.4, 0.64, 1),
  opacity 0.3s ease;
```

Cubic-bezier with the second control point at 1.4 produces a slight
overshoot — the panel "pops" into place rather than settling smoothly.

### Recursing into a sub-orb (transitionToLevel)

Implemented via the `transitioning` phase. Click a done sub-orb pill →
App sets `transitionOrigin` to the click pixel coords, `phase` to
`transitioning`. The CSS transition collapses the panel to that
position over 400ms. After the timeout fires, App swaps `currentOrbId`
to the sub-orb and sets `phase` back to `idle` — the panel re-expands
at center, now showing the sub-orb's content. `inAgentView` stayed
true the whole time so viewT didn't change.

The same machine handles "Back" from a sub-orb: collapse, swap to the
parent, re-expand. From a root orb, Back instead uses the `closing`
phase: collapse, then unmount (currentOrbId → null) and let viewT lerp
back to 0.

---

## Step 7 — Polish pass on the spec

### Ring layout

`ringPos(i, n)` was placing `i=0` at the bottom for any N (an upside-
down triangle for N=3, and so on). Switched to:

```ts
const a = Math.PI / 2 - (i / n) * Math.PI * 2;
```

so `i=0` is always at the *top*; subsequent orbs go clockwise. For
odd N we get an upward-pointing polygon (1 orb at top, rest symmetric
below). For N=1, the single orb still sits on a small ring (at the top)
rather than at origin, so it's distinct from the summoner.

`ringRadius(n)` always uses `Math.max(n, 2)` in the formula so the
chord between adjacent orbs stays approximately constant
(= RING_BASE_CHORD ≈ 2.8) regardless of N. With orb radius 0.55 the
chord-minus-diameter gap is ~1.7 units — orbs never overlap.

### Spawn-from-origin

Each `<group>` mounts at `position={[0, 0, 0]}` regardless of its
target ring/slot position. The `useFrame` lerps the actual position
toward `targetPos.current` (which is set from the prop each render).
Combined with the visScale lerp from 0, newly-summoned orbs visibly
emerge from the center summoner and grow into their ring slots.

### Label at center + label fades with orb

drei's `<Html>` portals to the DOM, so the parent group's 3D scale
does NOT affect the rendered label. Two changes:

1. `<Html position={[0, 0, 0]}>` puts the label visually inside the
   orb (before, it was 0.8 units below).
2. A `useRef<HTMLDivElement>` on the label wrapper, mutated each frame
   from `useFrame`: `labelRef.current.style.opacity = String(visScale.current)`.
   So when an orb fades to scale 0, its label fades with it. This is
   the fix for "when I click into the suborb, the top-level orb text
   also needs to disappear" — root orb labels now fade in lockstep
   with their group's visScale.

### Hover-X delete

Each orb tracks a local `hovered` state. `onPointerOver` on the mesh
sets it true; `onPointerOut` schedules a 160ms timer to set it false
(the timer is cancelled if the pointer enters the X button itself, so
moving from orb → X doesn't flicker).

When `hovered` is true, an `<Html>`-wrapped × button renders next to
the label with `pointer-events: auto`. Clicking it calls
`onDelete(orb.id)` which hits `DELETE /api/orbs/{id}` (already
implemented; cascades to descendants).

The `<Html>` wrapper has `pointerEvents="none"` overall so the label
itself doesn't block clicks on the orb mesh; only the X button
re-enables pointer events.

### Memory column (placeholder)

The orchestrator panel is now a 2-column grid: a 220px Memory column
on the left, the chat column on the right.

Memory items today are *derived* from the ancestor chain: each
ancestor contributes its `prompt` and (truncated) `result` as a "from
{ancestor_name}" inherited item. There's no backend memory storage
yet — when v2 ships proper memory items with `POST /api/orbs/{id}/memory`,
the panel will load them via REST and render alongside the inherited
chain.

This is intentional placeholder shape: the column is visually there
and shows that ancestors contribute context, but real saved memory is
deferred.

### Center summoner ("fire orb")

A wavy white orb at world origin (0, 0, 0). Vertex shader ports the
FBM noise from the orb fragment shader and uses it to displace each
vertex along its normal:

```glsl
vec3 pos = position + normal * disp;
```

where `disp = ((noise(...) * 0.6 + noise(...) * 0.4) - 0.5) * (0.22 + uExcite * 0.18)`.
Sphere geometry has 96×96 segments (vs. 64×64 for normal orbs) so the
displacement reads as smooth surface waves rather than facets.

Click → calls `onSummon` (= `createOrb('orb')` in App). On click,
`exciteRef.current = 1.0` and decays to 0 over ~1 second, momentarily
enlarging the displacement so the surface "pops" before settling.

The summoner is visible only in ring view (`1 - smoothstep(0.05, 0.6, viewT)`).
Its sphere is `ORB_RADIUS * 0.85` so it reads as visually distinct
from the ring orbs around it.

### Deletion

Backend `DELETE /api/orbs/{id}` already cascades to descendants and
broadcasts `orb_deleted` per killed id. Frontend listens via WS and
removes from `orbs`/`messages`/`streams` Maps. If the deleted orb is
the one currently being viewed, App also clears `currentOrbId` so the
panel unmounts cleanly.

Two delete affordances now exist:

- The hover-X on each orb in the 3D scene.
- A `✕` button in the panel header (with a `confirm()` prompt) for
  killing the orb you're currently inside.

---

## Design notes (not yet implemented — record for later)

The user's framing of the system, captured here so it's not lost:

> "the orbs at the very top go into the orchestrators. then the
> orchestrators spawn sub-orbs which use the context + prompt and give
> an output. eventually, the sub-orbs can be promoted to their own
> orchestrators recursively, and basically build this tree of context"

Two implications for the data + agent loop:

1. **Context flows down implicitly.** When a suborb's agent runs, its
   system prompt should include the context of every ancestor up to
   the root. Today (v0/v1) we only pass the suborb's `prompt` as a
   single user message. The proper implementation (slated for v2) walks
   the parent chain and formats inherited memory items into the system
   prompt before invoking the model.

2. **Promotion is just clicking in.** Already true: a suborb that the
   user clicks into becomes the active orchestrator and gets its own
   chat input that spawns further suborbs. The recursion is unbounded
   in principle (capped by `MAX_DEPTH` once we add it in v1).

These shape v2 ("context inheritance + save-up") and inform the system
prompt design in the agent loop.

---

## Step 8 — Tree-as-context: real memory + pin + promote + chart

The user's framing for this step:

> "suborb should basically take instructions from orchestrator, and become
> its own chat. that chat u can interact with or it will execute some task
> given by the orchestrator. then, you can either: merge memory with the
> orchestrator, or promote the suborb to its own orb. that suborb should
> be PINNABLE: pinning means being able to monitor the chat reasoning/
> progress/tool calls from main menu."

Followed by:

> "be very careful with how you wire this with the backend. in fact, think
> about how to represent the tree like structure of context. create a
> small 'orb chart' in the top right that represents the flow of context"

### Three invariants we're preserving

1. **The tree IS the context graph.** `parent_id` is the only edge
   defining inheritance. No precomputed inheritance tables; everything
   derives from a walk-up.
2. **Memory belongs to the orb that owns it.** When a finding is merged
   "↑", it becomes a `MemoryItem` whose `orb_id` is the *parent*. The
   parent now owns it; suborbs of the parent (current AND future)
   inherit it via the walk-up.
3. **Suborb agent context = walk-up product.** `run_agent` constructs
   its system prompt by walking from the suborb to root, formatting
   each level's memory items in order.

### Backend shape

New types:

```python
class MemoryItem:
    id: str
    orb_id: str                     # the orb that OWNS this item
    kind: 'note' | 'integrated' | 'context'
    text: str
    prompt: str | None              # for integrated items: the question
    source_orb_id: str | None       # the suborb that produced the finding
    source_orb_name: str | None     # cached name
    created_at: str

class Orb:
    ...
    pinned: bool                    # NEW
```

Storage: `memory_by_orb: dict[str, list[MemoryItem]]`.

New endpoints:

- `PATCH /api/orbs/{id}` — generic patch (`pinned`, `display_name`,
  `parent_id`). Cycle-checked when `parent_id` changes (a node can
  never become its own ancestor). `parent_id: null` is the "promote
  to root" path.
- `POST /api/orbs/{id}/memory` — add a memory item.
- `GET /api/orbs/{id}/memory` — own items.
- `GET /api/orbs/{id}/memory/inherited` — walk-up; each item is
  enriched with `depth` (1 = parent, 2 = grandparent…) and
  `source_name` for UI rendering.

WS: new `memory_added` event. `orb_updated` patches now also carry
`pinned` and `parent_id` changes.

### Agent context flow

The agent's system prompt is now **derived live** from the tree:

```
You are a suborb — an agent in a recursive agent OS where every node
is a long-lived agent. The user has spawned you to handle one focused
task within a larger orchestrator's context.

You are at: {breadcrumb}

Inherited context from your ancestors (deepest first):
  - [from {ancestor}] integrated: asked: ...→ answered: ...
  - [from {ancestor}] note: ...
  ...

Your own memory:
  - integrated (from sub: ...) — asked: ... → answered: ...
  ...

Respond in plain text — concise, direct, under ~200 words...
```

Built by `_build_system_prompt(orb)` which calls
`_format_inherited_memory` (walks ancestor chain) and
`_format_own_memory`. No memory state is duplicated; the walk happens
fresh on every agent invocation.

### Frontend additions

- `api.ts`: `MemoryItem`, `InheritedMemoryItem`, `MemoryKind` types;
  REST helpers `patchOrb`, `addMemory`, `listInheritedMemory`; new WS
  event `memory_added` handled in App.
- App holds a `memory: Map<string, MemoryItem[]>` keyed by orb id (own
  items per orb). Inheritance is computed in `Panel.gatherMemory` by
  walking `parent_id` through `orbsById` — exactly mirrors the
  backend's walk.
- Panel header now has:
  - **Pin / Pinned** — toggles `pinned` via PATCH. Pink when active.
  - **↑ merge** — only on suborbs with a result. Posts to parent's
    memory with `kind='integrated'`, `prompt=suborb.prompt`,
    `text=suborb.result`, `source_orb_id=suborb.id`. Triggers a brief
    teal panel-flash so the user sees the action register.
  - **⇈ promote** — only on suborbs. PATCH `parent_id: null`. The orb
    detaches from its parent and appears as a new root in the ring.
- Memory column renders inherited (purple-tinted) and own
  (teal-tinted for integrated items) memory in one list, with the
  source ancestor's name on inherited rows. Integrated items show
  the original prompt above the result text.

### Orb chart (top-right)

`OrbChart.tsx` — a small floating panel listing every orb in the
tree, indented by parent/child relationship. Each row has:

- A status dot (white = idle/done, purple-pulsing = working,
  red = failed, with extra glow if pinned).
- The display name (or "…" if unnamed).
- A pin glyph if pinned.
- Highlighted background if it's the current orb.

Click a row → navigates to that orb. Collapsing/expanding the panel
through the standard transition machinery if we're already in agent
view; if we're in ring view, the panel grows from the top-right
corner.

This is the user-visible representation of the tree-as-context
relationship. Reading it is reading the inheritance: memory at row N
is inherited by every row indented under it.

### Anthropic key wired

`backend/.env` now contains `ANTHROPIC_API_KEY=...`. `python-dotenv`
loads it at startup; `/health` reports `anthropic_configured: true`.
Real Claude calls happen on every chat message; suborb responses
stream live via the existing `output_chunk` events.

---

## Step 9 — Suborb chat windows + pinning means "monitor"

The user's mental model:

> "make it so when i click on a suborb, a chat window appears that i can
> directly interact with that orb for the task. then it has a pin button
> that i can press 'pin' on, which adds the chat window to the main orb
> menu for monitoring, like in the demo"

Combined with the prototype's pinning semantics: **pinned suborb =
floating progress card visible in main menu, showing live status +
streamed feed**. We made it interactive (the chat window IS the
monitoring surface).

### Model change

- Roots → orchestrator panel (the spatial-zoom UX).
- **Suborbs → floating chat window**, NOT an orchestrator panel.
- Recursion ("enter suborb as orchestrator") is gone. To give a suborb
  its own orchestrator panel, **promote** it (parent_id := null) — it
  becomes a root.

### Render set

App holds `openWindowIds: Set<string>` for transient windows (clicking
a suborb adds to it). Orbs with `pinned: true` are added on top.
Visible windows = `openWindowIds ∪ {ids where orb.pinned}`.

User flows:

| Action | Effect |
| --- | --- |
| click suborb (3D / pill / chart) | `openWindowIds.add(id)` |
| pin button on a window | PATCH `pinned: true`. Window persists. |
| unpin button | PATCH `pinned: false`. Window stays open while in `openWindowIds`. |
| ✕ close | remove from `openWindowIds` AND PATCH `pinned: false`. Window disappears completely. |
| navigate to ring view | windows for pinned orbs stay; transient windows stay until ✕ |

### `SuborbWindow.tsx`

A small floating panel (320px wide, max 60vh tall):

- Header: status dot, name, "thinking…" while running, pin/close buttons.
- Live stream box (visible while `status==='working'`): dashed-purple
  monospace ticker showing `streams.get(orb.id)` — the current run's
  output as it streams in. Mask-faded at the top.
- Messages list: same shapes as the orchestrator panel chat (user /
  agent / spawn pills). Spawn pills click → `onOpenChild(sub)` → opens
  another window.
- Input: typing `Enter` calls `sendMessage(orb.id, text)` → spawns a
  sub-suborb of THIS suborb. Disabled while the suborb's own run is in
  flight.

Windows are stacked vertically on the **left side** (top: 60px,
clear of the info icon; orb chart stays in the top-right).

The `pinned` class on the window adds a pink border + glow so the user
can see at a glance which windows are persisted.

### `Panel.tsx` change

`onEnterSubOrb(orb, screenPos)` is gone. Replaced with
`onOpenSuborbWindow(id: string)`. Click on a spawn pill in the
orchestrator panel chat now opens the suborb's window instead of
collapsing the panel into the suborb's orchestrator. The "click to
enter →" hint became "click to chat →".

### `OrbChart.tsx` change

Same dispatch: clicking a row whose orb is a suborb opens a chat
window; clicking a row whose orb is a root enters its orchestrator
panel.

---

## Step 10 — Final design model + iterations

This step captures the consolidated design after a long iteration loop
on the suborb chat window / pinning / drag / resize / orb-anchored
positioning behavior. All decisions are recorded here so the model is
findable in one place.

### The two-orb-role model (definitive)

| Role         | Created by                  | Visual surface           | Chat behavior                     | Pinnable? |
| ------------ | --------------------------- | ------------------------ | --------------------------------- | --------- |
| **orb** (root) | user clicks center summoner / spacebar | spatial-zoom orchestrator panel | typing → spawns a suborb (child)  | **No**   |
| **suborb**   | parent orchestrator's chat OR `spawn_orb` (v1+) | floating chat window        | typing → continues this suborb's conversation (multi-turn) | **Yes**  |

Both share the same `Orb` record; `kind` records origin. Promoting a
suborb (`PATCH parent_id=null`) converts it into a root in-place — its
descendants travel with it because they reference it by id, not parent.

### Recursion model

- Recursion happens via the **chat in a root**: each user message in a
  root spawns a fresh suborb. That suborb is its own conversation and
  doesn't recurse further when typed at — typing in a suborb's chat
  CONTINUES the suborb's conversation (the agent re-runs with full
  history).
- To recurse further, **promote** a suborb (it becomes a root) and
  chat in its orchestrator. New suborbs spawn from there.
- The orchestrator panel's "enter sub-orb as orchestrator" recursion
  is gone. No more "panel collapses into the suborb and re-expands"
  beyond the click-into-root case.

This is the user's stated model:
> "the suborb is just an executor/answerer of user prompt"
> "you can either: merge memory with the orchestrator, or promote the
>  suborb to its own orb"

### Tree-as-context (definitive)

- **Edges**: `parent_id` is the only edge. The tree IS the context graph.
- **Memory**: a `MemoryItem` belongs to one orb (`orb_id`). Inheritance
  is computed live by walking `parent_id` upward.
- **Agent system prompt** for a suborb run is built from a walk-up:
  breadcrumb + each ancestor's memory items, formatted with depth tags
  and source names. No precomputed inheritance; everything derives from
  the live tree.
- **Merge ↑**: copies a suborb's prompt+result into its parent's memory
  as an `integrated` MemoryItem with `source_orb_id` set. Future suborbs
  spawned in the parent inherit it via the walk-up.

### Backend behavior (definitive)

- `POST /api/orbs/{id}/messages` branches on the orb's `kind`:
  - **`orb` (root):** spawn a new suborb (child) with the user's text
    as `prompt`, fire-and-forget `run_agent`. Insert a `spawn` marker
    in the root's chat (renders as a pill).
  - **`suborb`:** append user message to the suborb's chat, set
    `status='working'`, and run `run_agent_continue` which builds a
    multi-turn message list (`orb.prompt` as first user turn + the
    suborb's chat history) and re-streams a response.
- `PATCH /api/orbs/{id}`: generic patch for `pinned`, `display_name`,
  `parent_id` (cycle-checked for promotion).
- Memory endpoints: `GET /memory`, `GET /memory/inherited` (walk-up),
  `POST /memory`.
- WS events: `orb_created`, `orb_updated`, `orb_deleted`,
  `message_added`, `memory_added`, `run_event` (kinds: thinking,
  output_chunk, tool_use, tool_result, done, error). `run_event` is
  transient — durable state is on the orb (`status`, `result`).
- Real Anthropic Claude wired up via `AsyncAnthropic.messages.stream`.
  Falls back to a deterministic placeholder stream when no API key.

### Frontend visual rules (definitive)

**Ring view (currentOrbId === null, viewT ≈ 0):**
- All ring orbs visible in a clockwise ring with `i=0` at top. Ring
  radius capped at `RING_MAX_R = 3.0` so adding more orbs shrinks the
  chord (no overflow off-screen).
- Center summoner ("fire orb"): wavy white sphere, vertex-displaced
  via FBM noise + chaos uniform. Click → spawn root.
- Right-click any orb → delete (cascades to descendants).
- Cloud overlay covers the screen; camera drifts subtly with mouse.
- Orbs animate from origin (0, 0, 0) outward to their ring slot on spawn.
- **Pinned summaries** anchored to each root that has pinned suborbs,
  positioned top-left of the root with slight overlap. Per the
  `images/image copy.png` mockup. Crossfade with chat windows.
- All chat windows are unmounted (transient cleared, pinned
  invisible). Pinning's only visible effect here is the summary card.

**Agent view (currentOrbId set, viewT ≈ 1):**
- Ring orbs scaled to 0; current orb hidden (you're inside it).
- Orchestrator panel centered, position-driven CSS transitions
  (cubic-bezier overshoot, 400ms). Grows from the orb's screen pos.
- Cloud parted around panel center via shader uniform.
- Camera parallax dampened to ~0.
- Suborbs of `currentOrbId` visible in slot row at world y=2.3, scale 1.0.
- **Chat windows visible** for the union of `openWindowIds` (transient)
  + all `pinned` suborbs. Pinned ones use floating mode (anchored to
  orb's projected pos, 130px outward — prototype's `positionCards`
  pattern). Transient stack on the left.

**Phase machine** (`'idle' | 'closing' | 'transitioning'`):
- `idle`: panel at center; viewT lerps to 1 (agent) or 0 (ring).
- `closing`: panel collapsing to `transitionOrigin`; will unmount
  after 400ms; viewT lerps back to 0.
- `transitioning`: panel collapsing → content swap → re-expand. viewT
  stays at 1. Used internally for sub-suborb-promotion gestures (rare
  now that suborbs don't have orchestrator panels).

### Chat window mechanics (definitive)

- **Open**: clicking a suborb anywhere (3D mesh, panel pill, orb chart)
  opens a window centered on the click position via `initialPos`. The
  window auto-promotes to fixed positioning so it appears "right on top
  of" the orb that was clicked.
- **Drag**: header drag. Cursor's offset from the window's top-left is
  captured at mousedown and held constant — new top-left = cursor pos
  − offset every mousemove. No center math, no transform offset
  — left/top is the actual top-left of the box. (Earlier center-based
  approaches caused half-window-size jumps on grab.)
- **Resize**: CSS `resize: both` enables corner-drag resize.
- **Pin**: `pinned` toggle on the orb. Pinning's ONLY effect is to show
  the summary card in ring view AND to auto-include the chat window in
  the agent-view render set when the user re-enters. Pinning does NOT
  prevent windows from disappearing in ring view.
- **X (close)**: removes from `openWindowIds` AND optimistically clears
  `pinned` locally (so the window vanishes immediately rather than
  waiting for the WS round-trip).
- **In ring view**: chat windows unmount entirely. State (drag pos,
  input text) is reset on next open.
- **In agent view**: pinned chats from any root re-appear with their
  floating positioning; transients stack on the left (or position
  themselves at their click origin).

### Pinned summary card (definitive)

- One card per root that has pinned descendants. Aggregates all pinned
  suborbs of that root.
- Anchored to the root orb's projected screen position (top-left, slight
  overlap), updated each frame by an rAF loop reading `orbScreenPosRef`.
- Card content: ROOT NAME + `N tasks` count, then per-suborb: name +
  feed lines (last few sentences of the suborb's stream) + status
  (thinking… / done / failed).
- Visible only in ring view (alpha = `1 - viewT/0.4`).
- Click → enters the root's orchestrator. The pinned chat windows
  re-appear there.
- Read-only — no chat input here. To interact with a pinned suborb,
  click into the root and use the chat window.

### OrbChart (top-right tree)

- Live tree of all orbs by parent_id, sorted by `created_at`.
- Status dots: white = idle/done, purple-pulse = working, red = failed.
- Pin glyph if pinned.
- **Roots are clickable** (open orchestrator). **Suborbs are inert** —
  to interact with one, click it in 3D / via a pill (in agent view) or
  via the summary card (which navigates to its root). To make a suborb
  clickable from the chart, promote it.

### Info menu (`i`)

- Bottom-left, click-only (no hover). Closes on outside click.
- Lists current keyboard / mouse shortcuts.

### Frontend file layout

```
frontend/src/
├── api.ts             # types + REST/WS client
├── App.tsx            # app state + phase machine + render orchestration
├── Scene.tsx          # R3F canvas, ring layout, summoner, cloud, parallax,
│                      # OrbMesh per orb (publishes screen pos to App refs)
├── orbShader.ts       # GLSL for the orb shader
├── Panel.tsx          # orchestrator panel (root view)
├── SuborbWindow.tsx   # floating chat window (suborb view)
├── PinnedSummary.tsx  # ring-view summary card
├── OrbChart.tsx       # top-right tree
└── styles.css         # all CSS (no Tailwind, no module CSS)
```

`viewTRef` and `orbScreenPosRef` live at App level. Scene's
`ViewTLerp` writes the former; `OrbMesh` writes the latter every
frame. SuborbWindow and PinnedSummary read from both via rAF loops to
position themselves.

### Key state shape (App.tsx)

```ts
const [orbs, setOrbs]                   = useState<Map<string, Orb>>(new Map());
const [messages, setMessages]           = useState<Map<string, Message[]>>(new Map());
const [streams, setStreams]             = useState<Map<string, string>>(new Map());
const [memory, setMemory]               = useState<Map<string, MemoryItem[]>>(new Map());
const [currentOrbId, setCurrentOrbId]   = useState<string | null>(null);
const [transitionOrigin, setTransitionOrigin] = useState<ScreenPos | null>(null);
const [phase, setPhase]                 = useState<Phase>('idle');
const [openWindowIds, setOpenWindowIds] = useState<Set<string>>(new Set());
const [windowInitialPos, ...]           = useState<Map<string, ScreenPos>>(new Map());

const mouseRef         = useRef<MousePos>({ x: 0, y: 0 });
const viewTRef         = useRef(0);
const orbScreenPosRef  = useRef<Map<string, ScreenPos>>(new Map());

const inAgentView = currentOrbId !== null && phase !== 'closing';
```

### Key invariants

1. **Tree IS context.** Never query memory by orb_id directly; always
   walk the tree. Same in backend (`run_agent` system prompt) and
   frontend (`gatherMemory` in Panel).
2. **Refs over state for per-frame data.** `viewT`, `orbScreenPos`, and
   drag-related values live in refs to avoid re-renders 60×/sec.
3. **Optimistic local updates** for actions that round-trip (pin/unpin,
   X close). The WS broadcast confirms; the local update keeps the UI
   responsive.
4. **rAF loops for DOM-on-3D positioning.** Anything that anchors to a
   3D orb's projected position uses rAF reading from `orbScreenPosRef`.
   This includes pinned chat windows AND pinned summary cards.
5. **`floating` is a *render mode*, not a *render set predicate*.** A
   single rendered window can switch between flex-stacked (transient)
   and floating (pinned) without unmount; the React component's
   internal refs (drag pos, input text) survive the toggle.
6. **All windows unmount in ring view.** Ring view's only chat-related
   surface is the PinnedSummary card. State loss across views is
   accepted.

---

## What's deliberately not in v0/v1

Tracked in `ARCH.md`:

- `spawn_orb` tool — agent cannot spawn its own children yet (the
  recursion is purely user-driven via root chat).
- 3D pinned-orb rendering (tiny dots orbiting their root in ring
  view, the prototype's pattern) — currently only the summary card
  surfaces in ring view.
- Wheel-resize on 3D orbs and double-click rename.
- Per-orb model override.
- JSON snapshot persistence (state lost on backend restart).
- Multi-user (`user_id` hardcoded `"me"`).
- Recursion limits, run cancellation, WS backpressure.
- Real tool integrations (calendar, mail, etc.).
