// Voice orchestrator stub. Real implementation in Task 9 (depends on
// Whisper.cpp / browser SpeechRecognition wiring).

import { ChatOrchestrator } from './ChatOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function VoiceOrchestrator(props: OrchestratorProps) {
  return <ChatOrchestrator {...props} />;
}
