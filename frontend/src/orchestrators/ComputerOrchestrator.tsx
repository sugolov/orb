// Computer-use orchestrator stub. Real implementation in Task 9 (or
// later — this depends on computer-use API maturity, may be BLOCKED).

import { ChatOrchestrator } from './ChatOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function ComputerOrchestrator(props: OrchestratorProps) {
  return <ChatOrchestrator {...props} />;
}
