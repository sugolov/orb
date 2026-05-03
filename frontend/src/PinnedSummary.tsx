// Small read-only summary card visible in ring view ONLY. One card
// per root orb that has any pinned suborbs in its lineage. Anchored to
// the root's projected screen position (top-left of the orb, slight
// overlap with it — see images/image copy.png mockup).
//
// Layout matches the prototype's progress-card pattern:
//
//   ┌───────────────────────────┐
//   │ CALENDAR       N TASKS    │   header: root name + count
//   ├───────────────────────────┤
//   │ taskA                     │   per-task block:
//   │   › reading data…         │     • name (bold)
//   │   › formatting output…    │     • feed lines (last N output chunks)
//   │   ✓ done                  │     • status hint
//   │ taskB                     │
//   │   › thinking…             │
//   ├───────────────────────────┤
//   │ ✓ DONE — CLICK ORB        │   footer hint
//   └───────────────────────────┘
//
// Clicking the card navigates to the root orb's orchestrator.

import { MutableRefObject, useEffect, useRef } from 'react';
import type { Orb } from './api';
import type { ScreenPos } from './Scene';

interface PinnedSummaryProps {
  /** The root that this card is anchored to. */
  rootOrb: Orb;
  /** All pinned suborbs in the root's lineage. */
  pinnedSuborbs: Orb[];
  /** Live partial text per orb id. */
  streams: Map<string, string>;
  /** App-shared refs from Scene. */
  viewTRef: MutableRefObject<number>;
  orbScreenPosRef: MutableRefObject<Map<string, ScreenPos>>;
  /** Click on the card → navigate to the root's orchestrator. */
  onClickRoot: (root: Orb) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Take the last few "lines" of an output stream, breaking on newlines
 *  or sentence-end punctuation and keeping each entry short enough to
 *  fit one line of the card (~36 chars). */
function feedLinesFor(stream: string, max = 3): string[] {
  if (!stream) return [];
  // split on sentences / newlines, drop empties, keep last `max`
  const parts = stream
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(-max).map((s) => (s.length > 36 ? s.slice(0, 35) + '…' : s));
}

export function PinnedSummary({
  rootOrb,
  pinnedSuborbs,
  streams,
  viewTRef,
  orbScreenPosRef,
  onClickRoot,
}: PinnedSummaryProps) {
  const elRef = useRef<HTMLDivElement>(null);

  // anchor to the root orb's projected screen position. The card
  // appears top-left of the orb with a slight overlap (matches mockup).
  // Visible only in ring view — fades out as we leave.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = elRef.current;
      if (!el) return;
      const t = viewTRef.current;
      // visible in ring view (t≈0); fades out as t rises
      const alpha = Math.max(0, 1 - Math.min(1, t / 0.4));
      if (alpha <= 0.005) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        return;
      }
      el.style.opacity = String(alpha);
      el.style.pointerEvents = 'auto';

      const pos = orbScreenPosRef.current.get(rootOrb.id);
      if (!pos) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        return;
      }

      const w = el.offsetWidth || 240;
      const h = el.offsetHeight || 160;
      // top-left of orb with a small inward overlap (the mockup shows
      // the card's bottom-right slightly over the top-left of the orb)
      const orbScreenRadius = 60; // approx
      const overlap = 18;
      let x = pos.x - w + overlap - orbScreenRadius * 0.4;
      let y = pos.y - h + overlap - orbScreenRadius * 0.4;
      // clamp
      x = clamp(x, 8, window.innerWidth - w - 8);
      y = clamp(y, 8, window.innerHeight - h - 8);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [rootOrb.id, viewTRef, orbScreenPosRef]);

  const allDone = pinnedSuborbs.every((o) => o.status === 'done');
  const anyWorking = pinnedSuborbs.some((o) => o.status === 'working');

  return (
    <div
      ref={elRef}
      className="pinned-summary"
      onClick={() => onClickRoot(rootOrb)}
      title={`${rootOrb.display_name || 'unnamed'} — click to enter`}
    >
      <div className="ps-header">
        <span className="ps-root">
          {(rootOrb.display_name || 'orb').toUpperCase()}
        </span>
        <span className={`ps-count ${anyWorking ? 'busy' : ''}`}>
          {pinnedSuborbs.length === 1
            ? '1 task'
            : `${pinnedSuborbs.length} tasks`}
        </span>
      </div>

      <div className="ps-body">
        {pinnedSuborbs.map((sub) => {
          const lines = feedLinesFor(streams.get(sub.id) || '');
          return (
            <div key={sub.id} className="ps-task">
              <div className="ps-task-name">{sub.display_name || '…'}</div>
              <div className="ps-feed">
                {sub.status === 'working' && (
                  <>
                    {lines.length === 0 && (
                      <div className="ps-feed-line">› thinking…</div>
                    )}
                    {lines.map((l, i) => (
                      <div key={i} className="ps-feed-line">{`› ${l}`}</div>
                    ))}
                  </>
                )}
                {sub.status === 'done' && (
                  <div className="ps-feed-line ps-done">✓ done</div>
                )}
                {sub.status === 'failed' && (
                  <div className="ps-feed-line ps-failed">× failed</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="ps-footer">
        {allDone && '✓ done — click orb'}
        {!allDone && anyWorking && 'working — click orb'}
      </div>
    </div>
  );
}
