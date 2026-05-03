// Research orchestrator stub. Falls through to chat surface for now;
// Task 9 in overnight.md fills out the two-pane (chat + sources) view.

import { ChatOrchestrator } from './ChatOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function ResearchOrchestrator(props: OrchestratorProps) {
  return <ChatOrchestrator {...props} />;
}
