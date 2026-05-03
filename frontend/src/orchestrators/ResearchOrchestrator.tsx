// Research orchestrator — STUB. Two-pane sketch: chat (planned) on
// the left, sources panel on the right. Real implementation requires
// a web-search provider (claude-research backend is BLOCKED until
// one is wired). Dispatch still works through the registry's echo
// fallback so the user can validate the routing.

import { PlaceholderOrchestrator } from './PlaceholderOrchestrator';
import type { OrchestratorProps } from '../OrchestratorPanel';

export function ResearchOrchestrator(props: OrchestratorProps) {
  return (
    <PlaceholderOrchestrator
      {...props}
      panelClass="research-panel"
      inputPlaceholder="research a topic…"
      bodySketch={
        <div className="placeholder-grid two-pane">
          <div className="placeholder-pane main">
            <div className="placeholder-pane-title">SYNTHESIS</div>
            <div className="placeholder-pane-body">
              the agent's running summary lands here as it reads.
              dispatched threads (sub-orbs) appear above the panel
              as small amber orbs and feed back into this view.
            </div>
          </div>
          <div className="placeholder-pane side">
            <div className="placeholder-pane-title">SOURCES</div>
            <div className="placeholder-pane-body">
              live-updating list of urls the agent is reading.
              each card shows snippet + cite affordance.
              <div className="placeholder-blocked">
                BLOCKED: needs a web-search provider (Brave / Exa /
                Tavily / Anthropic web_search). See PROGRESS.md.
              </div>
            </div>
          </div>
        </div>
      }
    />
  );
}
