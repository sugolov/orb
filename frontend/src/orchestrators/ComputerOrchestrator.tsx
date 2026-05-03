// Computer-use orchestrator — STUB. Sketch: large screen-stream pane
// with action log on the side. Real implementation needs screenshot +
// input infra (xvfb + pyautogui / playwright / Anthropic's
// computer-use beta). BLOCKED for now; dispatch falls through to
// echo so plumbing can be exercised.

import { PlaceholderOrchestrator } from './PlaceholderOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function ComputerOrchestrator(props: OrchestratorProps) {
  return (
    <PlaceholderOrchestrator
      {...props}
      panelClass="computer-panel"
      inputPlaceholder="describe what to do in the browser…"
      bodySketch={
        <div className="placeholder-grid two-pane wide-main">
          <div className="placeholder-pane main">
            <div className="placeholder-pane-title">SCREEN</div>
            <div className="placeholder-pane-body screen-stub">
              live screenshot of the controlled session.
              <div className="placeholder-blocked">
                BLOCKED: needs screenshot + input pipeline.
                See PROGRESS.md.
              </div>
            </div>
          </div>
          <div className="placeholder-pane side">
            <div className="placeholder-pane-title">ACTIONS</div>
            <div className="placeholder-pane-body">
              chronological log of every click / keypress / scroll
              the agent performs, with timestamps. user can pause
              and "take control" of the session manually.
            </div>
          </div>
        </div>
      }
    />
  );
}
