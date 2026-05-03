# Orb Shell — Architecture & Backend Design

A recursive AI-orchestrator OS shell. Every orb is an agent. Every agent has children. Context flows down the tree; conclusions bubble up.

This document is meant for an agent (e.g., Claude Code) to read and act on. It explains the design philosophy, the current frontend implementation, and a concrete plan for building the backend that makes the system real.

The current frontend is a single self-contained file: `orb-shell.html` (~1900 lines, runs in any modern browser). It has placeholder agent behavior (random delays, canned text). The job ahead is to replace those placeholders with a real backend that calls Claude (or any LLM), persists state, and streams progress back to the UI.

---

## 1. The Core Insight

**An orb is a long-lived conversational agent. The sub-orbs it spawns are themselves long-lived conversational agents. Recursion all the way down.**

When you chat with an orb, every message you send spawns a child orb. The child computes (talks to a model, uses tools, whatever) and produces a result. That child persists. You can:

- **Pin it** — track its progress with a floating card; it lights up pink with lightning chaos while working.
- **Click it** — see a summary popover with the prompt, the result, and quick actions.
- **Promote it** ("New orb →") — enter that child's own orchestrator, where you have a fresh chat, an inherited memory column, and the ability to spawn its own children. Recursion.

The tree of orbs isn't just a UI metaphor. **The tree IS the context-passing structure of the system.** When you're inside an orb four levels deep, the agent at that level reads:

1. Its own conversation so far at this level
2. Its own memory items
3. Its parent's memory items (tagged "from parent")
4. Its grandparent's memory items (tagged "from grandparent")
5. ... all the way up to root

So the act of going DEEPER narrows context to a focused task. The act of going UP broadcasts a finding so the parent and its siblings see it too. The two save buttons in the panel header (`↑ Memory`, `⇈ Root`) are how you choose your broadcast scope.

There is no architectural distinction between a "ring orb" (top-level: messages, files, music, mail, calendar, photos) and a "sub-orb." A ring orb is just an orb whose `parent_id` is null. They're seeded with default memory items; sub-orbs start with empty own-memory and rely entirely on inheritance until something is saved into them.

### Three states an orb can be in (informational only — same data structure)

| State | Visual | Meaning |
|---|---|---|
| **Idle** (ring orbs) | white, prominent | Top-level orchestrator, waiting for input |
| **Working** (sub-orb) | purple, lightning shader, glowing | Agent is computing |
| **Done** (sub-orb) | white, ring-orb-styled | Result is ready; clickable to summarize, promotable to enter |

"Promoted" isn't a new state — it just means the user has set this orb as `currentLevel`. Any orb can be the current level; the panel re-keys to show its memory, chat, and children.

---

## 2. Data Model

### 2.1 The orb (a node in the tree)

```ts
type Orb = {
  id: string;                      // uuid
  parent_id: string | null;        // null for ring orbs
  user_id: string;                 // owner
  display_name: string;            // shown in label, breadcrumb, tree
  user_renamed: boolean;           // distinguishes auto-label from user-set
  prompt: string | null;           // original user msg that spawned this (sub-orbs only)
  result: string | null;           // agent's response (sub-orbs only)
  status: 'idle' | 'working' | 'transitioning' | 'done' | 'failed';
  pinned: boolean;                 // tracked with a progress card
  created_at: timestamp;

  // user-controlled visual state (persists)
  base_pos: { x, y, z } | null;    // when user has dragged
  user_scale: number;              // when user has scrolled to resize
  custom_pos: boolean;             // true once user dragged (suppresses auto-layout)
};
```

### 2.2 Memory items

Memory is the unit of inheritable context. An orb's `ownMemoryItems` is what it has saved. The full memory view at any level is computed by walking up.

```ts
type MemoryItem = {
  id: string;
  orb_id: string;                  // owning orb
  kind: 'context' | 'preference' | 'recent' | 'note' | 'integrated';
  meta: string;                    // small uppercase tag shown in UI ("context", "from sub-orb", etc.)
  text: string;                    // the actual content
  from_orb_id: string | null;      // for kind=integrated (which sub-orb's content was integrated)
  created_at: timestamp;
};
```

Three flavors matter most:

- **Seeded** (kind=context|preference|recent) — what ring orbs come pre-populated with. Eventually, real implementations will derive these from actual user data (calendar events, recent messages, etc.).
- **Note** — manually authored / saved free-form content.
- **Integrated** — created when a user clicks `↑ Memory` or `⇈ Root` on a sub-orb. The text is a summary of the sub-orb's findings; `from_orb_id` records which sub-orb it came from.

### 2.3 Messages (chat history)

Each orb has its own chat thread. Messages are spoken in the *parent's* chat and reflected as a "spawn" marker tied to the new sub-orb.

```ts
type Message = {
  id: string;
  orb_id: string;                  // which orchestrator's chat this lives in
  role: 'user' | 'agent' | 'spawn' | 'system';
  content: string;                 // for user/agent/system
  spawned_orb_id: string | null;   // for role=spawn, the child this represents
  created_at: timestamp;
};
```

Spawn messages render as inline cards in the chat that update from "spawning" → "↩ {name} — click to enter" once the child finishes. They have a pin button.

### 2.4 Runs (agent execution log)

When an agent invocation kicks off, create a `Run` record. This is what streams.

```ts
type Run = {
  id: string;
  orb_id: string;                  // sub-orb being computed
  status: 'pending' | 'running' | 'done' | 'failed';
  started_at: timestamp;
  ended_at: timestamp | null;
  events: Event[];                 // append-only stream of progress events
};

type Event =
  | { type: 'thought', text: string, ts }
  | { type: 'tool_use', name: string, input: object, ts }
  | { type: 'tool_result', output: any, ts }
  | { type: 'output_chunk', text: string, ts }
  | { type: 'final', result: string, ts };
```

These feed the progress card you see when an orb is pinned.

### 2.5 The recursive memory query

This is the fundamental query. Given an orb, get all memory items visible to its agent (own + all ancestors), tagged with their source orb.

```sql
WITH RECURSIVE ancestor_chain AS (
  SELECT id, parent_id, display_name, 0 AS depth
  FROM orbs WHERE id = $orb_id

  UNION ALL

  SELECT o.id, o.parent_id, o.display_name, a.depth + 1
  FROM orbs o
  JOIN ancestor_chain a ON o.id = a.parent_id
)
SELECT
  m.id, m.kind, m.meta, m.text, m.created_at,
  a.display_name AS source_orb_name,
  a.depth        AS source_depth   -- 0 = own, 1 = parent, 2 = grandparent, ...
FROM memory_items m
JOIN ancestor_chain a ON m.orb_id = a.id
ORDER BY a.depth DESC, m.created_at DESC;
```

Render order: deepest ancestor first (root → ... → parent → own). This matches the frontend's `ancestorChain(orb)` walker exactly.

---

## 3. Frontend Code Map (where things live in `orb-shell.html`)

The frontend is one file because portability mattered more than modularity at this stage. Splitting up is fine eventually. For now, here's where to look:

### Three.js scene

- `makeOrb({label, color, isTask})` — creates a Three.js group with one shell mesh. No halo, no core (those were removed). The shader is inline GLSL with fresnel rim, multi-octave noise haze, plus a `uChaos` lightning effect for working tasks.
- `stepRingOrb(o, dt, t)` — per-frame update for ring orbs. Spring physics toward `applyRingRotation(basePos)` unless `customPos`. View-state-aware: scales down to 0 in agent view.
- `stepTaskOrb(o, dt, t)` — per-frame update for task/sub-orbs. Calls `computeTaskOrbVisible` and `computeTaskOrbTarget`. The size formula lerps between regimes via `view.t`: pinned orbs are tiny (0.30) at ring view, grow to 0.85 at agent view.

### Position math

- `computeTaskOrbVisible(o)` — returns 0 or 1. Hidden when `o === currentLevel` (you're inside it). Visible if pinned, or if direct child of `currentLevel`.
- `computeTaskOrbTarget(o, t)` — the layout function. Honors:
  - `customPos` → user-dragged, returns basePos directly
  - pinned + ring view → orbits root ring orb at radius 0.85
  - pinned + agent + parent === currentLevel → slot row (basePos)
  - pinned + agent + parent visible (sub-sub cascade) → orbits the visible parent at radius 0.5
  - pinned + agent + parent not visible → ambient row at y=3.3
  - non-pinned → basePos
- `isAgentVisibleTaskOrb(o)` — helper used for the cascade check.

### State machine

- `view.state` ∈ `'orbs' | 'agent'`, `view.t` ∈ `[0,1]` (lerped).
- `currentLevel` = the orb whose orchestrator panel is open (null = ring view).
- `enterFromRing(orb)`, `transitionToLevel(orb)`, `goBack()`, `exitFully()` — the four state transitions. They animate the orchestrator panel (collapse to orb pos → swap content → re-expand).

### Memory rendering

- `renderMemoryColumn(orb)` — walks `ancestorChain(orb)`, concatenates each ancestor's `ownMemoryItems` with a "↑ {ancestor name}" tag, then orb's own items. Re-rendered every time you save or transition.
- `seedMemoryItems(label)` — placeholder for ring orb defaults (currently three canned items). **Replace with real user-context data when you wire the backend.**

### Chat / dispatch (the placeholder agent)

- `dispatchTask(prompt)` — called when user hits Enter in the chat. Currently:
  1. Creates DOM elements (user msg, spawn marker, task list entry)
  2. Creates a 3D orb (purple, lightning shader)
  3. `setTimeout(() => completeTask(...), 2400-5200ms)` — **this is the placeholder.** Replace with a real agent call.
- `completeTask(orb, prompt)` — transitions orb to white, sets `result = fakeResult(prompt)`, updates DOM markers from "running" → "done" / clickable.
- `fakeResult(prompt)` — returns a stub string. **Replace with real result from the backend.**
- `PROGRESS_LINES`, `startProgressFeed(orb)` — random ticker for pinned orbs. **Replace with real streaming events from the run log.**

### Save-up / save-up-to-root

- `saveCurrentLevelToAncestor(target)` — adds a kind=integrated item to `target.userData.ownMemoryItems`, then re-renders the current level's memory column. Buttons `↑ Memory` (parent) and `⇈ Root` both call this with different targets.

### Drag / resize / rename

- `pointerdown` picks an orb via raycast → records `dragOffset` in world space at the orb's z-plane.
- `pointermove` past 4px = drag → updates `basePos` from unprojected mouse, sets `customPos = true`.
- `pointerup` without drag → schedules click after 280ms; second click within 280ms cancels and triggers rename.
- `wheel` event on hovered orb → mults `userScale` by `exp(-deltaY * 0.0014)`, clamped 0.35×–3.2×.
- Rename overlays `<input id="rename-input">` at the orb's screen position. Enter commits, Escape cancels, blur commits.

### Tree

- `buildTree()` / `buildSubtree(orb)` — recursive. Renders nested HTML at bottom-left. Clicking a row → `transitionToLevel(orb)` or `enterFromRing(orb)`. Refreshes every 800ms.

---

## 4. Backend Design

The frontend is currently a sealed simulation. To make it real, build a backend that:

1. Persists the orb tree, memory, messages, and runs.
2. Invokes Claude (or another model) when chat messages come in.
3. Streams progress events back so the UI can show what the agent is doing.
4. Supports multiple users eventually (start with single-user, design for multi).

### 4.1 Stack recommendation

**Strongly recommend:** Python + FastAPI + SQLite (later: Postgres) + Anthropic SDK + WebSockets.

Reasons: Anthropic's Python SDK is the most mature, FastAPI gives you typed APIs and WebSocket support out of the box, SQLite is good enough until you need multi-process. The whole backend can live in a few hundred lines.

Alternative: Node + Hono/Express + SQLite + Anthropic JS SDK + Socket.io. Equally fine; pick based on familiarity. The architectural shape is identical.

If you want it truly local-first (the user's eventual Linux-distro vision), package the backend as a process that the Tauri/Electron shell launches alongside the UI. SQLite stays on disk in `~/.orb-shell/state.db`.

### 4.2 REST endpoints

```
POST   /api/orbs                         spawn a new orb
                                         body: { parent_id, prompt }
                                         returns: orb with status='working', kicks off agent run
GET    /api/orbs/:id                     get orb state
PATCH  /api/orbs/:id                     update (rename, pin, position, scale)
                                         body: any subset of {display_name, user_renamed, pinned, base_pos, user_scale, custom_pos}
DELETE /api/orbs/:id                     soft-delete orb + descendants

GET    /api/orbs/:id/children            direct children
GET    /api/orbs/:id/tree                full subtree (used to hydrate the UI on load)

GET    /api/orbs/:id/messages            chat history at this level
POST   /api/orbs/:id/messages            this is THE chat endpoint —
                                         body: { content }
                                         creates a user msg, spawns a child orb,
                                         starts a run, returns the new orb id

GET    /api/orbs/:id/memory              own memory items
POST   /api/orbs/:id/memory              add a memory item
                                         body: { kind, meta, text, from_orb_id? }
GET    /api/orbs/:id/memory/inherited    full inherited chain (ancestor walk)
                                         returns items grouped by source_orb

GET    /api/orbs/:id/runs                runs for this orb
GET    /api/runs/:id                     specific run with events
```

`POST /api/orbs/:id/messages` is the heart of the system. One request triggers: persist user message, create child orb, start run, kick off async agent invocation, return immediately with the child orb's id. The frontend then opens a WebSocket subscribed to that run/orb to watch it complete.

### 4.3 WebSocket protocol

Single connection per session. After connect, client sends:

```json
{ "type": "subscribe", "orb_ids": ["uuid1", "uuid2", ...] }
```

Server pushes events:

```json
{ "type": "orb_status",   "orb_id": "...", "status": "working" }
{ "type": "orb_status",   "orb_id": "...", "status": "done", "result": "..." }
{ "type": "run_event",    "orb_id": "...", "run_id": "...", "event": { "type": "thought", "text": "analyzing context" } }
{ "type": "run_event",    "orb_id": "...", "run_id": "...", "event": { "type": "tool_use", "name": "calendar_query", "input": {...} } }
{ "type": "run_event",    "orb_id": "...", "run_id": "...", "event": { "type": "output_chunk", "text": "Based on..." } }
{ "type": "memory_added", "orb_id": "...", "item": { ... } }
{ "type": "orb_created",  "parent_id": "...", "orb": { ... } }
{ "type": "orb_deleted",  "orb_id": "..." }
```

The frontend's `startProgressFeed` ticker becomes a subscription that adds a `feedLine` to the orb's progress card whenever a `run_event` comes in for it.

### 4.4 The agent loop (pseudocode)

```python
async def post_message(orb_id, content):
    """User typed a message in orb_id's chat."""
    user_id = current_user()

    # 1. Persist user message in parent's chat
    msg = await db.insert_message(orb_id=orb_id, role='user', content=content)

    # 2. Create child orb (will be the sub-orb)
    child = await db.insert_orb(
        parent_id=orb_id,
        user_id=user_id,
        prompt=content,
        display_name=auto_label(content),  # 1-3 word title
        status='working',
    )
    await broadcast({'type': 'orb_created', 'parent_id': orb_id, 'orb': child})

    # 3. Spawn marker in parent's chat
    await db.insert_message(orb_id=orb_id, role='spawn', spawned_orb_id=child.id)

    # 4. Kick off the run asynchronously
    asyncio.create_task(run_agent(child.id))

    return child  # return immediately

async def run_agent(orb_id):
    """Invoke Claude with the appropriate context for this orb."""
    orb = await db.get_orb(orb_id)
    run = await db.insert_run(orb_id=orb_id, status='running')

    # Build context — the recursive memory walk
    context = await build_agent_context(orb)

    system_prompt = format_system_prompt(orb, context)

    accumulated = []
    try:
        async with anthropic.messages.stream(
            model='claude-opus-4-7',
            max_tokens=4096,
            system=system_prompt,
            messages=context['parent_chat_history'] + [
                {'role': 'user', 'content': orb.prompt}
            ],
            tools=available_tools(),  # optional
        ) as stream:
            async for event in stream:
                if event.type == 'content_block_delta':
                    chunk = event.delta.text
                    accumulated.append(chunk)
                    await db.append_run_event(run.id, {
                        'type': 'output_chunk', 'text': chunk
                    })
                    await broadcast({
                        'type': 'run_event',
                        'orb_id': orb_id,
                        'run_id': run.id,
                        'event': {'type': 'output_chunk', 'text': chunk}
                    })
                elif event.type == 'tool_use':
                    # log + execute tool, append result, etc.
                    ...

        result = ''.join(accumulated)

        # 5. Persist final result and mark done
        await db.update_orb(orb_id, result=result, status='done')
        await db.update_run(run.id, status='done')
        await broadcast({
            'type': 'orb_status',
            'orb_id': orb_id,
            'status': 'done',
            'result': result,
        })
    except Exception as e:
        await db.update_orb(orb_id, status='failed')
        await db.update_run(run.id, status='failed')
        await broadcast({'type': 'orb_status', 'orb_id': orb_id, 'status': 'failed'})
        raise

async def build_agent_context(orb):
    # Recursive memory query
    inherited = await db.get_ancestor_memory(orb.id)
    own = await db.get_own_memory(orb.id)

    # Recent chat at the parent's level (the conversation that spawned this orb)
    parent_chat = []
    if orb.parent_id:
        parent_chat = await db.get_recent_messages(orb.parent_id, limit=20)

    # Optional: also fetch the orb's own chat history if it's been promoted before
    own_chat = await db.get_recent_messages(orb.id, limit=20)

    return {
        'memory': {'inherited': inherited, 'own': own},
        'parent_chat_history': format_for_claude(parent_chat),
        'own_chat_history': format_for_claude(own_chat),
        'breadcrumb': await db.get_breadcrumb(orb.id),
    }
```

### 4.5 The system prompt

```
You are an agent inhabiting one node in a hierarchical orchestrator system.
Each "orb" you see referenced is a long-lived agent (one of your siblings,
ancestors, or yourself). Context inherits down the tree; conclusions are
saved up explicitly.

You are at: {breadcrumb}  (e.g., "calendar › Yo › Hello")

Memory inherited from your ancestors (most recent first, deepest ancestor last):
{format_inherited(memory.inherited)}

Your own memory items:
{format_own(memory.own)}

The user has just sent you a message. Your job:
1. Respond in plain text — concise, direct, no markdown decoration unless useful.
2. If your task warrants follow-up sub-tasks, MENTION them at the end in the
   form: "I'd recommend spawning sub-orbs for: <one-line desc>, <another>".
   The orchestrator UI will offer those as one-click branches.
3. If you discover something worth saving to a higher level, end with:
   "Worth saving to {ancestor_name}: <summary>"
   and the user can promote it.
4. Use tools when appropriate. They give you read access to actual user data
   (calendar, mail, files) keyed to this user.
```

The format for memory items:

```
[from {source_orb}] {kind}: {text}
```

So inherited items are clearly marked by source. The agent can reason about provenance ("this came from my ancestor 'calendar'; treat it as canonical scheduling preference").

### 4.6 Tools (where this gets interesting)

The agent at any orb can be given different tool subsets based on the orb's identity. A `messages` ring orb exposes message-search tools; a `calendar` ring orb exposes calendar tools. Sub-orbs inherit their parent's tool set (or a filtered version).

```python
def available_tools(orb):
    root = get_root(orb)
    base_tools = [memory_save, sub_orb_spawn]  # universally available
    if root.display_name == 'calendar':
        return base_tools + [calendar_list, calendar_create, calendar_search]
    if root.display_name == 'messages':
        return base_tools + [imessage_search, send_message]
    # ...
```

`memory_save` lets the agent itself save into its own memory. `sub_orb_spawn` lets the agent dispatch its own sub-tasks (recursive — your agent can spawn sub-agents to handle parts of a complex task without the user clicking).

### 4.7 The frontend wiring (migration steps)

In `orb-shell.html`, replace the placeholder paths:

```js
// BEFORE (current)
function dispatchTask(prompt) {
  // ... DOM setup ...
  const orb = makeOrb({...});
  // ...
  setTimeout(() => completeTask(orb, prompt), 2400 + Math.random() * 2800);
}

// AFTER (with backend)
async function dispatchTask(prompt) {
  // ... DOM setup synchronously for instant feedback ...
  const orb = makeOrb({...});

  // Tell the backend: spawn a child of currentLevel with this prompt
  const response = await fetch(`/api/orbs/${currentLevel.serverId}/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({content: prompt}),
  });
  const { orb: serverOrb } = await response.json();

  // Bind the local orb to the server orb
  orb.userData.serverId = serverOrb.id;

  // Subscribe to its run via WebSocket
  ws.send(JSON.stringify({ type: 'subscribe', orb_ids: [serverOrb.id] }));

  // Real result arrives via WebSocket; completeTask is now triggered by an event
}

ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  const orb = findOrbByServerId(msg.orb_id);
  if (!orb) return;

  switch (msg.type) {
    case 'run_event':
      if (msg.event.type === 'output_chunk') {
        addFeedLine(orb, msg.event.text, 'thinking');
      }
      break;
    case 'orb_status':
      if (msg.status === 'done') {
        orb.userData.result = msg.result;
        completeTask(orb, orb.userData.prompt);  // existing function
      }
      break;
    // ...
  }
});
```

Memory operations:

```js
// BEFORE
function saveCurrentLevelToAncestor(target) {
  target.userData.ownMemoryItems.unshift({...});
  renderMemoryColumn(currentLevel);
}

// AFTER
async function saveCurrentLevelToAncestor(target) {
  const item = {
    kind: 'integrated',
    meta: 'from sub-orb',
    text: (currentLevel.userData.result || '').slice(0, 240),
    from_orb_id: currentLevel.serverId,
  };
  await fetch(`/api/orbs/${target.serverId}/memory`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(item),
  });
  // The WebSocket will broadcast 'memory_added' which re-renders.
  // Or for snappier UX, optimistically update locally and reconcile.
}
```

The `taskLabel(prompt)` auto-labeler in the frontend should eventually be replaced by the backend. After the agent's first response arrives, the backend can pick a 1–3 word display name (based on the prompt + the result) and PATCH the orb. The frontend listens for that update and renames the orb.

### 4.8 Persistence shape

When a user opens the app:

```
GET /api/orbs/tree
```

Returns the full orb tree (or just ring orbs + lazy-load deeper subtrees). The frontend hydrates by calling `makeOrb` for each, restoring `display_name`, `pinned`, `base_pos`, `user_scale`, `custom_pos`. The 3D scene rebuilds with the user's prior layout and rename history intact.

Tree on disk is just the orb table; building the tree object is `WHERE parent_id = $id` repeated, or a single recursive CTE for the whole subtree.

---

## 5. The Recursive Insight (Restated)

To replicate this design from scratch, internalize:

1. **Every node is the same data structure.** Ring orbs and sub-orbs differ only in `parent_id is null` vs not. Don't make a Domain Object hierarchy.

2. **The tree is the context.** When you invoke an agent at orb X, you're invoking it with `walk_up(X)` worth of memory plus its own. You don't have to think about "passing context" — the tree IS the context, and SQL handles the walk.

3. **Memory is one-way down, conclusions are one-way up.** This asymmetry is what makes the system useful. Children inherit automatically (no copy). Saving to an ancestor is a deliberate broadcast to a wider audience. There's no symmetric "share with all my children" operation because that's the default; the explicit operation is widening scope.

4. **The orb is also the chat thread is also the agent identity.** When you "click into" an orb, the chat you see was the chat that happened INSIDE it during prior visits. Returning to an orb later means resuming that conversation with the same agent identity (same memory, same context, same name).

5. **Sub-orbs are not transient task results.** They persist. They're not "the result of running task X once" — they're "the agent that runs task X, which has now run once." If you click into it later and chat more, the same agent answers, with full memory of its prior run.

This is what makes the system feel different from a chat with a model. It's a forest of long-lived agents, each with their own context, each able to spawn more.

---

## 6. Open Questions for Implementation

A few things the design hasn't pinned down yet, marked here so an agent picking this up knows what's deliberately unfinished:

### Auto-naming

`taskLabel(prompt)` in the frontend produces a 1–3 word title from the prompt by stop-word filtering. Crude. The backend should generate names with the model — pass the prompt + result and ask for a 1–3 word title. PATCH the orb when ready.

### Auto-summarization for `↑ Memory`

The current "Save" action takes the first 240 characters of the result. A real implementation should ask the model to produce a memory-fragment summary suitable for an ancestor's memory column.

### Orb deletion semantics

Deleting an orb cascades to descendants (`removeOrb` in the frontend kills the subtree). Is that always the right behavior? Maybe a soft-delete that orphans children to grandparent. TBD.

### Pinning persistence and feed retention

Currently pinned status is per-session. Persist via PATCH on the orb. Progress feed (events from runs) — keep the last N? Forever? At what cost?

### Multi-user

Don't bake auth in early. But design the schema with `user_id` columns from day one (above schema does this). When you add Clerk/Supabase Auth/etc., it slots in.

### The Linux-distro / Tauri vision

The eventual goal is a real OS shell. For now, run it as a web app — the backend serves both the static `orb-shell.html` and the API. Once stable, package via Tauri so the shell becomes a desktop app, and eventually ship as a NixOS module that boots straight into the shell.

### Voice and eye tracking

The user has mentioned both. Voice via Whisper.cpp (local, fast) feeding into the chat input. Eye tracking via WebGazer.js (browser) or Tobii (desktop) — at minimum, drive the camera parallax via gaze instead of mouse. Both are pure frontend additions; the backend doesn't need to know.

### Tool integrations

Each ring orb's tool set defines what kinds of agents live in that branch. `calendar` should hit the system calendar API. `messages` should hit iMessage / SMS. `mail` should hit Gmail/IMAP. Start with one (calendar is the easiest demo) and extend.

---

## 7. Recommended Build Order

If you're handing this to Claude Code, the path of least surprise:

1. **Backend skeleton.** FastAPI app, SQLite schema (sections 2.1–2.4), CRUD endpoints for orbs/memory/messages. No agent invocation yet. ~200 lines.

2. **Hydrate the frontend from the backend.** Replace the hardcoded ring orbs in `orb-shell.html` with `GET /api/orbs/tree` on load. Persist drag/resize/rename via PATCH. No agent yet.

3. **Wire `dispatchTask` to `POST /api/orbs/:id/messages`.** Have the backend respond with a stub immediately, simulating the model with the same fake-result string, but persisted. Now the orb tree survives reloads.

4. **WebSockets.** Send `orb_status` events when status changes. Frontend updates from these instead of internal `setTimeout`.

5. **Real Claude.** Replace the stub in `run_agent` with `anthropic.messages.stream(...)`. Stream `output_chunk` events. The pinned progress card now shows actual model output as it generates.

6. **Recursive memory query.** Implement the CTE. `GET /api/orbs/:id/memory/inherited`. Frontend's `renderMemoryColumn` becomes a fetch; works the same.

7. **Tool integration.** Pick one (calendar). Wire as an Anthropic tool. Watch agents pull real data.

8. **Voice + eye tracking + Tauri packaging.** Bonus, as time permits.

Each step works in isolation. After step 2, the system is persistent. After step 5, it's actually intelligent. After step 7, it's actually useful.

---

## 8. Reference Files

- `orb-shell.html` — the entire current frontend, single file.
- (this file) — design + backend spec.

When picking this up, read `orb-shell.html` end-to-end first. It's not modular but it's linear and well-commented in the trickier sections (memory rendering, position math, pointer multiplexing). The patterns there (spring physics, view-state lerping, recursive ancestor walks) are the same patterns you'll apply backend-side.