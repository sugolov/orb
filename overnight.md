# Overnight Plan — Pluggable Orchestrators, Pluggable Agents, Dispatcher Reframe

You are working autonomously overnight on the `orchestrator-pluggability` branch. Read the existing design docs first:

- `ARCHITECTURE.md` — overall system design
- `VIEW_TRANSITIONS.md` — ring-orb-to-orchestrator zoom semantics
- `PINNING_AND_CHAT.md` — chat window and pinning model
- `RING_ORB_SPECIALIZATION.md` — agent type system, code orb spec

Two big shifts you'll be making to the system:

1. **The orchestrator is no longer a chatbot. It's a dispatcher.** The orchestrator panel's job is to fire off agents (sub-orbs) — not to hold long conversations itself. The conversation lives in the sub-orb. The orchestrator is mostly just a launchpad with memory context, sub-orb spawning, and the panel header. This is a meaningful UX change from the current implementation.

2. **Agents are pluggable backends.** Any agent backend (Claude, Claude Code, opencode CLI, a custom API, eventually local models) should be wireable as an orb type via a clean adapter interface. When spawning a new sub-orb, the user selects which agent to use — not just which agent *type*, but which specific *backend* (e.g., "Claude Sonnet 4.6 via Anthropic API" vs "Claude Code subprocess" vs "Codex CLI").

Work through tasks in order. After each: commit, append to `.claude/PROGRESS.md`, start the next. Don't pause for confirmation. If genuinely blocked (not just hard — blocked, like requires API keys you don't have or external services that aren't configured), mark `BLOCKED:` in PROGRESS.md and skip to the next independent task.

If you finish before morning, polish: animations, visual rough edges, tests, minor refactors. Document changes.

---

## Task 1: Extract orchestrator surface as a pluggable concept

The three-column panel currently is hardcoded. Refactor so its body is determined by `currentLevel.userData.agentType`.

- Add `agentType: 'chat' | 'code' | 'research' | 'computer' | 'voice'` to every orb's userData (default to `'chat'`).
- Create a registry: `ORCHESTRATOR_SURFACES = { chat: {...}, code: {...}, ... }`. Each entry: `templateHTML`, `init(orb)`, `cleanup()`, `onDispatch(prompt, agentSelection)`, `onFrame(dt, t)` (optional).
- The shell of the panel (header, back, status, breadcrumb, action buttons, chat input) stays shared. Only `#panel-body` and the spawn-input behavior get swapped.
- The current three-column UI becomes the `chat` entry — though it'll be heavily reworked in task 3.

Re-entering existing chat orbs should look and behave identically. Commit.

## Task 2: Add agent type to ring orbs

Replace current six (`messages, files, music, mail, calendar, photos`) with the typed set:

- `chat` (white) — general conversation/dispatcher
- `code` (cyan, `#7dd3fc`) — Claude Code-style
- `research` (amber, `#fbbf24`) — web research
- `computer` (pink, `#f472b6`) — browser/desktop automation
- `voice` (violet, `#c4b5fd`) — voice-first
- `memory` (white, type=chat) — pre-seeded with personal context placeholders

Each orb's `agentType` and base color set at creation. Update `uColor` shader uniform per type. Update labels.

Clicking non-chat orbs at this point still opens the chat surface — fine, just colored differently. Commit.

## Task 3: Reframe the chat orchestrator as a dispatcher

This is the conceptual shift. The chat orchestrator currently has the orchestrator agent ("I'm watching the calendar orb. What do you want done?") replying to messages — making the orchestrator feel like its own chatbot. Change this:

The orchestrator panel does NOT have its own conversation history. Its job is purely to:

- Show memory context (left column, unchanged)
- Receive instructions from the user (input bar)
- Fire off sub-orbs to handle them (each instruction → one sub-orb)
- Show those sub-orbs (above the panel) and the list of recent ones (right column)

The orchestrator does not "reply." When the user types something, no message appears in the panel from an orchestrator-agent — instead, a sub-orb spawns, and the conversation with that sub-orb is the chat. The user opens the sub-orb's chat (via clicking → floating chat window) to interact with it.

The center column of the panel becomes a "recent dispatches" log instead of a chat thread:

- A scrollable list of cards, one per recent sub-orb spawned at this level.
- Each card: orb icon (small, colored by type), prompt that spawned it, agent backend used, status (working/done), pin/promote buttons.
- Click a card → opens that sub-orb's floating chat window.
- This list is also reflected by the floating orbs above the panel.

The bottom of the panel still has an input field, but it's now framed as "dispatch" not "chat":

```
[ agent selector dropdown: ▼ Claude (chat) ] dispatch a task...
```

The agent selector is a dropdown showing available backends (see task 4). Default to whatever matches the orchestrator's type (chat orb defaults to "Claude (chat)"; code orb defaults to "Claude Code"; etc.), but the user can override per-dispatch — e.g., dispatch a research-type sub-orb from inside a chat orchestrator.

Memory column behavior is unchanged. Sub-orbs above the panel are unchanged. Sub-orb interaction (chat window, pin, promote) is unchanged. The only thing that goes away is the orchestrator's own chat-like back-and-forth.

Mental model after this change: orchestrator = dispatcher, sub-orb = conversation. Test by spawning several sub-orbs from a single orchestrator and confirming none of them produce orchestrator-side replies. Commit.

## Task 4: Backend agent registry — pluggable agents

Define a clean adapter interface for "an agent backend." Any backend that conforms to this interface can be plugged in as an option for spawning sub-orbs.

In `agents/` (new directory):

```
agents/
  registry.js          // central registry, getAvailableAgents(), spawnAgent(...)
  base.js              // AgentBackend interface / base class
  claude_chat.js       // Claude via Anthropic API, chat persona
  claude_code.js       // Claude Code via subprocess
  claude_computer.js   // Claude with computer-use tools
  claude_research.js   // Claude with web search tools
  echo.js              // Test backend that just echoes the prompt
```

The interface (`base.js`):

```js
export class AgentBackend {
  // Metadata for UI
  static id = 'unique-id';                  // 'claude-chat', 'claude-code', etc.
  static displayName = 'Display Name';      // shown in dropdown
  static agentType = 'chat';                // matches ring orb types
  static color = '#ffffff';                 // visual tint
  static description = '...';               // tooltip text

  // Lifecycle
  constructor(config) { /* per-spawn config */ }

  async start(orb, prompt, callbacks) {
    // Begin the agent. Stream events back via callbacks:
    // callbacks.onThought(text)
    // callbacks.onToolUse(name, input)
    // callbacks.onToolResult(output)
    // callbacks.onChunk(text)
    // callbacks.onMessage(role, content)        // for chat backends
    // callbacks.onDone(finalResult)
    // callbacks.onError(err)
  }

  async sendMessage(orb, content, callbacks) {
    // Send a follow-up message to an existing agent (for chat-style backends).
    // Streams events the same way.
  }

  async stop(orb) { /* cleanup, kill subprocess, close session */ }

  serialize() { /* return json state for persistence */ }
  static deserialize(data) { /* restore from json */ }
}
```

Implement at least these backends in skeleton form (real wiring in task 7):

- `EchoBackend` (id: 'echo'): always available; just echoes the prompt back with a small delay. Used for testing. Default for `chat` if no API key configured.
- `ClaudeChatBackend` (id: 'claude-chat'): wraps Anthropic SDK call. agentType: 'chat'. Reads API key from env var `ANTHROPIC_API_KEY`. If unset, falls back to echo behavior with a warning.
- `ClaudeCodeBackend` (id: 'claude-code'): spawns `claude` CLI as a subprocess (if installed) and pipes I/O. agentType: 'code'. Falls back to echo if `claude` CLI not in PATH.
- `ClaudeComputerBackend` (id: 'claude-computer'): stub for now. agentType: 'computer'.
- `ClaudeResearchBackend` (id: 'claude-research'): stub for now. agentType: 'research'.

The registry exposes:

```js
getAvailableAgents()           // → array of backend metadata, filtered by what's actually usable in this env
getAgentsForType(agentType)    // → array filtered by agentType match
getDefaultAgentForType(type)   // → preferred backend for this orb type
spawnAgent(backendId, orb, prompt, callbacks)  // → instance + lifecycle
```

The agent dropdown in the dispatcher (from task 3) populates from `getAgentsForType(currentLevel.agentType)` plus a small "+ other" affordance to expand to all agents.

Test: open the chat orchestrator, dropdown shows Claude (chat) + Echo. Open the code orchestrator, dropdown shows Claude Code + Echo. Switch backends, dispatch, confirm correct backend is invoked (visible in the streaming output style). Commit.

## Task 5: Wire backend events into sub-orb visuals

Currently sub-orbs use a `setTimeout` placeholder. Replace with real backend invocation:

- When user dispatches, registry's `spawnAgent` is called with callbacks that route into the orb's UI:
  - `onThought` / `onToolUse` / `onChunk` → if pinned, append to chat window's streaming output; always update orb's internal feed log.
  - `onDone(result)` → orb transitions to done state, label updates, etc.
  - `onError(err)` → orb transitions to failed state (new visual: red tint, error in chat).
- The orb's `userData` gains: `backend` (id of the backend instance), `backendInstance` (the actual instance ref).
- When user opens sub-orb's chat and types a follow-up, route it through `backendInstance.sendMessage(...)` — the same orb, same backend, ongoing conversation.
- When orb is dismissed/deleted, call `backendInstance.stop(orb)` to clean up.

Test by spawning sub-orbs of various types, confirming the right backend handles each, watching streaming output flow into the chat window. Use Echo backend to verify the plumbing works without external dependencies. Commit.

## Task 6: Build the code orchestrator surface

Now that backends exist, the code orchestrator can have its own surface:

- Optional left sidebar: file tree of the working directory (collapsible, default collapsed).
- Main pane: terminal-style scrollback, monospace, full-bleed. Shows the agent's actions: command output, file edits as diff snippets, test results.
- Header above main: current dispatched task description.
- Bottom: dispatch input — same shape as chat dispatcher, but framed for code ("describe a coding task...").

Style: monospace throughout main pane, dark teal/cyan accents, character-by-character or chunk streaming for live feel.

Code orbs spawn opencode-style sub-orbs:

- Smaller cyan orb, no chaos lightning, subtle pulse.
- Doesn't float above panel by default — appears as inline collapsible section in terminal scrollback (`▶ Task: refactor auth module`).
- Click expands inline to show full transcript of that code session.
- Pinning extracts it to a floating sub-orb above the panel + a docked chat window on the right edge.

Default backend for code orchestrator: `claude-code`. Falls back to echo if CLI not installed.

Test by clicking the code ring orb and dispatching a fake code task. Commit.

## Task 7: Real backend wiring (where possible)

Wire the actual backends. For each, implement the real `start`/`sendMessage`/`stop` if dependencies allow:

- `ClaudeChatBackend`: requires `@anthropic-ai/sdk`. If env doesn't have `ANTHROPIC_API_KEY`, log warning and fall back to echo. Use streaming. Build the system prompt from the orb's inherited memory chain (per `ARCHITECTURE.md` section 4.5).
- `ClaudeCodeBackend`: spawn `claude --print --output-format stream-json` as subprocess if `claude` is in PATH. Pipe stdin for prompt, stream stdout events. Otherwise fall back.
- `ClaudeResearchBackend`: real or stub depending on whether you can configure web search tools. If real, use Anthropic SDK with the web search tool. If stub, mark BLOCKED in PROGRESS.md.
- `ClaudeComputerBackend`: very likely BLOCKED — computer use requires significant infra. Mark and skip.

For each one BLOCKED, document in PROGRESS.md what's needed (env vars, dependencies, infra).

Commit each backend wiring separately so they're individually revertable.

## Task 8: UI more sub-orb centric

Look at the system overall after the dispatcher reframe. Sub-orbs should now be unmistakably the focus. Apply visual polish:

- Sub-orbs above panel: clearer presence, hover tooltip showing agent type + first line of recent output.
- Subtle connecting lines from sub-orbs to the orchestrator panel (very faint, suggesting parentage).
- Pinned chats on right edge: small ID dots in their headers matching their orb's color in 3D.
- Panel background slightly more transparent so the orb scene above it stays foregrounded.
- Type-color visible everywhere: sub-orb cards in the dispatch log column carry their backend's color tint.

Design polish, not a rewrite. The goal: when looking at the screen, the sub-orbs are obviously the thing, the panel is obviously infrastructure. Commit.

## Task 9: Stub remaining surfaces

Stub research, computer-use, voice orchestrator surfaces in the registry. Functional placeholders with right base color and rough layout sketch ("research orchestrator — coming soon" or similar). This proves the registry supports more than two types and gives scaffolding for later. Commit.

## Task 10: Polish

If time:

- Animations: type-color transitions, sub-orb spawn/done animations per type.
- Accessibility: keyboard reach, tab order.
- Performance: profile entering an orchestrator, spawning 5 sub-orbs, panning. Note slowdowns in PROGRESS.md.
- Documentation: add a "Pluggable Architecture" section to `ARCHITECTURE.md` describing the orchestrator-surface registry, the agent-backend registry, the dispatcher reframe, and how to add new backends. Don't rewrite existing sections — add to them.

Commit each polish item separately.

---

## Constraints

- Don't change the data model in `ARCHITECTURE.md` substantially without good reason. Orb tree, memory inheritance, message structure stay as specified.
- The orchestrator-as-dispatcher reframe (task 3) is the only fundamental UX change in this batch. Don't introduce others.
- Don't break the existing system. After every commit, the chat orchestrator must still work end-to-end (dispatch a sub-orb, click to open chat, pin, promote, return).
- If you find yourself rewriting more than two core functions in a single task, stop. You may be solving the wrong problem.
- Keep commits small. One conceptual change per commit.
- Use `git status` / `git diff` liberally. Don't accumulate large uncommitted changes.
- Don't make network calls except `git push`. Don't `npm install` new packages without strong justification (note: anthropic SDK is justified; pretty-printing libraries are not).
- After every commit, mentally trace through: click chat orb → dispatch sub-orb → click sub-orb → chat in floating window → pin → return to ring view. If you can't trace this cleanly, you've broken something — investigate before continuing.

## When to stop

- All 10 tasks completed and committed, OR
- You've genuinely hit a wall on whatever task you're on AND the next several tasks all depend on it.

In either case, write a final summary in `PROGRESS.md` describing branch state and what's left.