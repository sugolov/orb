// Legacy import shim. The actual orchestrator dispatch lives in
// `OrchestratorPanel.tsx`; existing imports of `Panel` continue to work
// by aliasing through this file so we don't have to touch App.tsx in
// the same task that introduces the router.

export { OrchestratorPanel as Panel } from './OrchestratorPanel';
