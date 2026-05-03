// Code orchestrator stub. Real implementation in Task 6 (terminal
// surface + bash/file tools). Until then this component falls through
// to the chat orchestrator so dispatching/clicking still does
// something useful — only the visual is colored differently via
// agentTypes.ts. The placeholder note below is shown in dev so the
// stub state is obvious.

import { ChatOrchestrator } from './ChatOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function CodeOrchestrator(props: OrchestratorProps) {
  return <ChatOrchestrator {...props} />;
}
