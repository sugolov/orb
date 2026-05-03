// OrchestratorPanel — thin router. Picks the right orchestrator
// surface based on the orb's `agent_type` and passes through the same
// props every surface needs. See `agentTypes.ts` for the visual side
// and `orchestrators/` for the per-type bodies.
//
// Adding a new agent type:
//   1. Add literal to AgentType in api.ts (and backend AgentType).
//   2. Add an entry in agentTypes.ts.
//   3. Add a backend in `backend/src/agents/`.
//   4. Add a component in `orchestrators/<Type>Orchestrator.tsx`.
//   5. Add a case to the switch below.
// TypeScript's exhaustive-switch warning will catch a missed case.

import type { MemoryItem, Message, Orb } from './api';
import type { ScreenPos } from './Scene';
import type { Phase } from './App';
import { ChatOrchestrator } from './orchestrators/ChatOrchestrator';
import { CodeOrchestrator } from './orchestrators/CodeOrchestrator';
import { ResearchOrchestrator } from './orchestrators/ResearchOrchestrator';
import { ComputerOrchestrator } from './orchestrators/ComputerOrchestrator';
import { VoiceOrchestrator } from './orchestrators/VoiceOrchestrator';

/** Common props every orchestrator surface receives. The shell (panel
 *  border, blur, header, back button, transition origin animation) is
 *  managed inside each concrete component for now since they share so
 *  much CSS — deduping into a wrapper is a future refactor once two
 *  bodies actually exist. */
export interface OrchestratorProps {
  orb: Orb;
  messages: Message[];
  orbsById: Map<string, Orb>;
  streams: Map<string, string>;
  memory: Map<string, MemoryItem[]>;
  transitionOrigin: ScreenPos;
  phase: Phase;
  onClose: () => void;
  /** Click on a suborb pill / list card → open its floating chat
   *  window. screenPos is the pixel position so the window opens
   *  centered on where the user clicked. */
  onOpenSuborbWindow: (id: string, screenPos?: ScreenPos) => void;
  onDelete: (id: string) => void;
  onMergeUp: (orb: Orb) => void;
  onPromote: (id: string) => void;
}

export function OrchestratorPanel(props: OrchestratorProps) {
  switch (props.orb.agent_type) {
    case 'chat':
      return <ChatOrchestrator {...props} />;
    case 'code':
      return <CodeOrchestrator {...props} />;
    case 'research':
      return <ResearchOrchestrator {...props} />;
    case 'computer':
      return <ComputerOrchestrator {...props} />;
    case 'voice':
      return <VoiceOrchestrator {...props} />;
    default: {
      // exhaustiveness guard — adding a new AgentType without a case
      // here is a TypeScript error.
      const _exhaustive: never = props.orb.agent_type;
      void _exhaustive;
      return <ChatOrchestrator {...props} />;
    }
  }
}
