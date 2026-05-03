// Voice orchestrator — STUB. Sketch: large transcription view +
// mic button. Real implementation needs Whisper.cpp wiring (or
// browser SpeechRecognition) for input and TTS for output. Dispatch
// still works via text fallback (so the input row at the bottom is
// the temporary primary modality).

import { PlaceholderOrchestrator } from './PlaceholderOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function VoiceOrchestrator(props: OrchestratorProps) {
  return (
    <PlaceholderOrchestrator
      {...props}
      panelClass="voice-panel"
      inputPlaceholder="…or type instead"
      bodySketch={
        <div className="placeholder-voice">
          <div className="placeholder-mic">🎙</div>
          <div className="placeholder-mic-label">push-to-talk · coming soon</div>
          <div className="placeholder-pane-body voice-transcript">
            <div className="placeholder-pane-title">TRANSCRIPT</div>
            conversation surfaces here as plain text. voice in,
            voice out. push-and-hold the mic button to speak.
            <div className="placeholder-blocked">
              BLOCKED: needs Whisper.cpp (input) + TTS (output)
              integration. Text input below is the temporary
              fallback for dispatching a sub-orb.
            </div>
          </div>
        </div>
      }
    />
  );
}
