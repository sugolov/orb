// Floating chat window for one suborb. The suborb is an
// executor/answerer: typing in this window does NOT spawn another
// suborb — it continues the same suborb's conversation.
//
// Positioning model (all coords are TOP-LEFT, no transform offsets,
// no center math — the only invariant we maintain is the cursor's
// offset from the window's top-left corner during a drag):
//
//   • initialPos (from App, computed at click time): the orb's screen
//     position. We center the window on it (top-left = pos - size/2).
//   • drag: cursor offset from top-left is captured at mousedown and
//     held constant. New top-left = cursor - offset every mousemove.
//   • floating + no drag yet: rAF loop reads the orb's live screen pos
//     from orbScreenPosRef and re-anchors the window 130px outward
//     from screen center (matches the prototype's positionCards).

import {
  MutableRefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Message, Orb } from './api';
import { sendMessage } from './api';
import { agentTypeOf } from './agentTypes';
import type { ScreenPos } from './Scene';

interface SuborbWindowProps {
  orb: Orb;
  messages: Message[];
  streams: Map<string, string>;
  onClose: () => void;
  onTogglePin: () => void;
  /** Click "↑ merge" → save this suborb's prompt+result into its
   *  parent (orchestrator) as an integrated MemoryItem. The next
   *  suborb spawned in the parent will inherit this finding via the
   *  agent's system-prompt walk-up. */
  onMergeUp: (orb: Orb) => void;
  /** Click "⇈ promote" → detach into a root orb (parent_id := null). */
  onPromote: (id: string) => void;
  /** Screen position the window should INITIALLY appear at, centered.
   *  Set when the user clicks the suborb so the chat box opens "right
   *  on top of it". Used only on first mount when persistedState is
   *  not present. */
  initialPos?: ScreenPos | null;
  /** Persisted size+position from a previous session (drag/resize).
   *  When present, takes priority over initialPos so the window
   *  re-opens at the same place/size after view transitions. */
  persistedState?: { x: number; y: number; w: number; h: number } | null;
  /** Reports drag-end and debounced resize back to App so the persisted
   *  state map stays in sync. */
  onStateChange?: (state: { x: number; y: number; w: number; h: number }) => void;
  /** Floating mode = pinned. Window auto-anchors to its orb's projected
   *  position in 3D, fades out in agent view. */
  floating?: boolean;
  orbsById?: Map<string, Orb>;
  viewTRef?: MutableRefObject<number>;
  orbScreenPosRef?: MutableRefObject<Map<string, ScreenPos>>;
}

/** Return a published screen-pos for `orbId` if available, else walk
 *  up the parent chain. Suborbs aren't rendered in 3D in ring view,
 *  so we fall back to their root which is. */
function findAnchorPos(
  orbId: string,
  orbsById: Map<string, Orb>,
  posMap: Map<string, ScreenPos>,
): ScreenPos | null {
  const own = posMap.get(orbId);
  if (own) return own;
  let cur = orbsById.get(orbId);
  while (cur && cur.parent_id) {
    const parent = orbsById.get(cur.parent_id);
    if (!parent) break;
    const ppos = posMap.get(parent.id);
    if (ppos) return ppos;
    cur = parent;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function SuborbWindow({
  orb,
  messages,
  streams,
  onClose,
  onTogglePin,
  onMergeUp,
  onPromote,
  initialPos,
  persistedState,
  onStateChange,
  floating = false,
  orbsById,
  viewTRef,
  orbScreenPosRef,
}: SuborbWindowProps) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const rootElRef = useRef<HTMLDivElement>(null);

  // user-positioned top-left (set by initialPos / persistedState /
  // drag). When non-null the auto-anchor logic is skipped.
  const customPosRef = useRef<{ x: number; y: number } | null>(null);
  // drag state: cursor's offset from window's top-left at mousedown
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  // track whether we've consumed the initial mount restore step
  const initializedRef = useRef(false);
  // reactive ref so callbacks (drag/resize) call the LATEST onStateChange
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // SYNCHRONOUSLY (before paint) apply persistedState if present, else
  // initialPos. This is the only way to avoid the (0, 0) flash that
  // occurs when a floating window mounts and CSS gives it
  // `position: fixed; left: 0; top: 0` until the rAF loop fires next
  // frame.
  useLayoutEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const el = rootElRef.current;
    if (!el) return;

    if (persistedState) {
      // restore previous size + position
      customPosRef.current = { x: persistedState.x, y: persistedState.y };
      el.classList.add('dragged');
      el.style.left = `${persistedState.x}px`;
      el.style.top = `${persistedState.y}px`;
      el.style.width = `${persistedState.w}px`;
      el.style.height = `${persistedState.h}px`;
    } else if (initialPos) {
      // first-time open: center on click position
      const w = el.offsetWidth || 320;
      const h = el.offsetHeight || 320;
      customPosRef.current = {
        x: initialPos.x - w / 2,
        y: initialPos.y - h / 2,
      };
      el.classList.add('dragged');
      el.style.left = `${customPosRef.current.x}px`;
      el.style.top = `${customPosRef.current.y}px`;
    }

    // hide floating windows briefly so they don't flash at (0,0) before
    // the rAF loop runs and (re-)positions them. The rAF will set the
    // correct opacity (alpha by viewT) on its first tick.
    if (floating) {
      el.style.opacity = '0';
    }
    // non-floating windows use CSS default opacity (visible) — fine
    // because they sit in flex layout, not at (0,0).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ResizeObserver — debounce so dragging the corner doesn't spam state
  // updates. Reports back to App via onStateChangeRef.
  useEffect(() => {
    const el = rootElRef.current;
    if (!el) return;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (!onStateChangeRef.current) return;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!onStateChangeRef.current) return;
        const rect = el.getBoundingClientRect();
        const pos = customPosRef.current ?? { x: rect.left, y: rect.top };
        onStateChangeRef.current({
          x: pos.x,
          y: pos.y,
          w: rect.width,
          h: rect.height,
        });
      }, 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // auto-scroll on new messages or stream chunks
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streams]);

  // floating mode: rAF loop. Either honors customPosRef (drag/initial)
  // or auto-anchors to the orb's projected screen pos + 130px outward
  // from screen center, viewport-clamped.
  useEffect(() => {
    if (!floating || !orbsById || !viewTRef || !orbScreenPosRef) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = rootElRef.current;
      if (!el) return;
      const t = viewTRef.current;
      // chat windows are visible in AGENT view (t ≈ 1) and hidden in
      // ring view (t ≈ 0) — the inverse of the prototype's progress
      // cards. Ring view shows the PinnedSummary card instead, which
      // cross-fades with this window via viewT.
      const alpha = Math.max(0, Math.min(1, (t - 0.4) / 0.4));
      if (alpha <= 0.005) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        return;
      }
      el.style.opacity = String(alpha);
      el.style.pointerEvents = 'auto';

      const w = el.offsetWidth || 320;
      const h = el.offsetHeight || 320;

      // user-positioned: just clamp to viewport and apply
      if (customPosRef.current) {
        const x = clamp(customPosRef.current.x, 8, window.innerWidth - w - 8);
        const y = clamp(customPosRef.current.y, 8, window.innerHeight - h - 8);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        return;
      }

      // auto-anchor — exact prototype pattern (positionCards):
      // window center at (orb screen pos + 130px outward).
      const pos = findAnchorPos(orb.id, orbsById, orbScreenPosRef.current);
      if (!pos) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        return;
      }
      const ccx = window.innerWidth / 2;
      const ccy = window.innerHeight / 2;
      const dx = pos.x - ccx;
      const dy = pos.y - ccy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const offset = 130;
      const targetCx = pos.x + ux * offset;
      const targetCy = pos.y + uy * offset;
      // convert center to top-left, clamp to viewport
      const left = clamp(targetCx - w / 2, 8, window.innerWidth - w - 8);
      const top = clamp(targetCy - h / 2, 8, window.innerHeight - h - 8);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [floating, orb.id, orbsById, viewTRef, orbScreenPosRef]);

  // window-level mouse listeners for drag. The invariant during drag
  // is the cursor's offset from the window's top-left, captured at
  // mousedown — NEW top-left = cursor - offset, every mousemove.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const newLeft = e.clientX - ds.offsetX;
      const newTop = e.clientY - ds.offsetY;
      customPosRef.current = { x: newLeft, y: newTop };
      // for non-floating windows the rAF loop isn't running, so apply
      // position directly here
      if (!floating) {
        const el = rootElRef.current;
        if (el) {
          el.classList.add('dragged');
          el.style.left = `${newLeft}px`;
          el.style.top = `${newTop}px`;
        }
      }
    };
    const onUp = () => {
      const wasDragging = dragRef.current !== null;
      dragRef.current = null;
      setDragging(false);
      // persist on drag-end so size+position survive view changes
      if (wasDragging && onStateChangeRef.current && customPosRef.current) {
        const el = rootElRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          onStateChangeRef.current({
            x: customPosRef.current.x,
            y: customPosRef.current.y,
            w: rect.width,
            h: rect.height,
          });
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [floating]);

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // don't start dragging from button clicks
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    e.preventDefault();
    const el = rootElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // capture the cursor's offset from the window's top-left. This is
    // the single invariant maintained throughout the drag.
    dragRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    setDragging(true);
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setInput('');
    try {
      await sendMessage(orb.id, text);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const liveStream = orb.status === 'working' ? streams.get(orb.id) || '' : '';

  // Per Task 8 polish: small ID dot in the header matches the orb's
  // agent-type color in 3D, so chat windows on the right edge are
  // visually traceable back to their orb. The window's left-border
  // accent also uses the type color when idle/done; the working
  // pulse stays purple to keep the "thinking" signal universal.
  const typeDef = agentTypeOf(orb);
  const dotColor =
    orb.status === 'failed'
      ? '#ff6b6b'
      : orb.status === 'working'
      ? undefined // let CSS animation drive it
      : `#${typeDef.color.toString(16).padStart(6, '0')}`;

  return (
    <div
      ref={rootElRef}
      className={`suborb-window status-${orb.status} ${orb.pinned ? 'pinned' : ''} ${floating ? 'floating' : ''}`}
      style={{
        // type-tinted left border so the window's identity is
        // immediately readable. Inline so it overrides the .pinned
        // class's pink border when applicable.
        ['--type-accent' as string]: typeDef.cssAccent,
      }}
    >
      <div
        className={`window-header ${dragging ? 'dragging' : ''}`}
        onMouseDown={onHeaderMouseDown}
      >
        <span
          className={`window-dot ${orb.status}`}
          style={dotColor ? { background: dotColor, boxShadow: `0 0 6px ${dotColor}` } : undefined}
        />
        <span className="window-name">{orb.display_name || '…'}</span>
        {orb.status === 'working' && (
          <span className="window-status">thinking…</span>
        )}
        <div className="window-spacer" />
        {/* merge ↑ — saves this suborb's prompt + result into its
         *  parent's (orchestrator's) memory. Only enabled when the
         *  agent has produced a result. */}
        {orb.status === 'done' && !!orb.result && (
          <button
            className="window-btn teal"
            onClick={(e) => {
              e.stopPropagation();
              onMergeUp(orb);
            }}
            title="save this finding into the orchestrator's memory"
          >
            ↑ merge
          </button>
        )}
        {/* promote ⇈ — detach into a new root orb */}
        <button
          className="window-btn teal"
          onClick={(e) => {
            e.stopPropagation();
            onPromote(orb.id);
          }}
          title="detach this suborb to become its own root orb"
        >
          ⇈
        </button>
        <button
          className={`window-btn ${orb.pinned ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          title={
            orb.pinned
              ? 'unpin (closes when you ✕)'
              : 'pin (show summary in ring view)'
          }
        >
          {orb.pinned ? 'pinned' : 'pin'}
        </button>
        <button
          className="window-btn icon"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="close"
        >
          ✕
        </button>
      </div>

      <div className="window-messages" ref={messagesRef}>
        {orb.result && messages.filter((m) => m.role === 'agent').length === 0 && (
          <div className="window-msg agent">{orb.result}</div>
        )}
        {messages.map((m) => {
          if (m.role === 'user' && m.content) {
            return (
              <div key={m.id} className="window-msg user">
                {m.content}
              </div>
            );
          }
          if (m.role === 'agent' && m.content) {
            return (
              <div key={m.id} className="window-msg agent">
                {m.content}
              </div>
            );
          }
          return null;
        })}
        {liveStream && <div className="window-msg agent live">{liveStream}</div>}
        {messages.length === 0 && !orb.result && !liveStream && (
          <div className="window-empty">no chat yet</div>
        )}
      </div>

      <div className="window-input-row">
        <span className="input-prompt">›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="ask this orb…"
          disabled={submitting || orb.status === 'working'}
        />
      </div>
    </div>
  );
}
