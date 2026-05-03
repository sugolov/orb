// Frontend registry for agent-type visuals + UX wiring.
//
// This is the SINGLE SOURCE OF TRUTH for everything visual that depends
// on an orb's agent_type — base color, working/done color variants,
// orchestrator-component identifier, and suborb policy. The backend
// has its own registry (`backend/src/agents/`) covering system prompts
// + tools + per-type agent loops; the two stay in sync via the shared
// AgentType literal in `api.ts`.
//
// Adding a new agent type requires:
//   1. Add the literal to AgentType in api.ts AND backend AgentType.
//   2. Add an entry here.
//   3. Add a backend in `backend/src/agents/`.
//   4. Add an orchestrator component in `frontend/src/orchestrators/`.
//   5. Wire it into `OrchestratorPanel.tsx`'s switch.
//
// TypeScript's exhaustiveness checking on the AgentType union forces
// each switch to handle every type — if you add one without updating
// the others, the compiler will tell you.

import type { AgentType } from './api';

export interface AgentTypeDef {
  id: AgentType;
  /** Short human label shown in 3D below the orb name and in dropdowns. */
  label: string;
  /** Verbose description for tooltips / dropdown subtitles. */
  description: string;
  /** Base color of the orb in the resting state (idle/done). Hex int. */
  color: number;
  /** Saturated/brighter variant used while a suborb is `working`.
   *  When unset we fall back to a generic purple, matching the v0
   *  behavior. */
  workingColor?: number;
  /** Whether suborbs spawned at this orchestrator type appear as
   *  floating orbs above the panel (chat-style) or stay inline / are
   *  managed differently. */
  spawnsSuborbsAbovePanel: boolean;
  /** Subtle CSS color used to tint type-aware UI bits (panel border
   *  accent, dispatch input glow, sub-orb card border in the dispatch
   *  log). Decoupled from the 3D `color` so we can pick a CSS-friendly
   *  value (alpha-tunable, named-readable). */
  cssAccent: string;
}

export const AGENT_TYPES: Record<AgentType, AgentTypeDef> = {
  chat: {
    id: 'chat',
    label: 'CHAT',
    description: 'General conversational dispatcher. Spawn agents to answer questions, plan, brainstorm.',
    color: 0xffffff,
    workingColor: 0xa78bfa, // existing purple
    spawnsSuborbsAbovePanel: true,
    cssAccent: 'rgba(255, 255, 255, 0.7)',
  },
  code: {
    id: 'code',
    label: 'CODE',
    description: 'Claude-Code-style. Bash + file edit tools, terminal-like surface.',
    color: 0x7dd3fc, // sky-300
    workingColor: 0x38bdf8, // sky-400
    spawnsSuborbsAbovePanel: false, // code work is mostly linear
    cssAccent: 'rgba(125, 211, 252, 0.85)',
  },
  research: {
    id: 'research',
    label: 'RESEARCH',
    description: 'Web search + synthesis. Two-pane orchestrator: chat + sources.',
    color: 0xfbbf24, // amber-400
    workingColor: 0xf59e0b, // amber-500
    spawnsSuborbsAbovePanel: true, // research-thread suborbs
    cssAccent: 'rgba(251, 191, 36, 0.85)',
  },
  computer: {
    id: 'computer',
    label: 'COMPUTER',
    description: 'Browser/desktop automation. Screen stream + action log.',
    color: 0xf472b6, // pink-400
    workingColor: 0xec4899, // pink-500
    spawnsSuborbsAbovePanel: false, // linear, single session
    cssAccent: 'rgba(244, 114, 182, 0.85)',
  },
  voice: {
    id: 'voice',
    label: 'VOICE',
    description: 'Voice-first ambient agent. Mic + transcript.',
    color: 0xc4b5fd, // violet-300
    workingColor: 0xa78bfa, // violet-400
    spawnsSuborbsAbovePanel: true, // voice dispatcher
    cssAccent: 'rgba(196, 181, 253, 0.85)',
  },
};

export function agentTypeOf(orb: { agent_type?: AgentType }): AgentTypeDef {
  return AGENT_TYPES[orb.agent_type ?? 'chat'];
}
