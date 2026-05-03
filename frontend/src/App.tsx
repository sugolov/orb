// Top-level app. Holds orb / message / stream state, wires REST + WS,
// owns the spatial-zoom phase machine, tracks the window mouse for
// camera parallax.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Scene, type ScreenPos, type MousePos } from './Scene';
import { Panel } from './Panel';
import {
  addMemory,
  createOrb,
  deleteOrb,
  listOrbs,
  patchOrb,
  useWS,
  type MemoryItem,
  type Message,
  type Orb,
  type RunEvent,
  type ServerEvent,
} from './api';
import { OrbChart } from './OrbChart';
import { SuborbWindow } from './SuborbWindow';
import { PinnedSummary } from './PinnedSummary';

/** Small info icon in the top-left. Click-only (hover doesn't expand)
 *  so it doesn't get in the way as the cursor moves around. */
function InfoMenu() {
  const [open, setOpen] = useState(false);
  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.info-menu')) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div
      className={`info-menu ${open ? 'open' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <div className="info-icon">i</div>
      <div className="info-body">
        <div className="info-row">
          <b>click center orb</b> summon a new orb
        </div>
        <div className="info-row">
          <b>space</b> summon a new orb
        </div>
        <div className="info-row">
          <b>click root orb</b> open orchestrator
        </div>
        <div className="info-row">
          <b>right-click orb</b> delete
        </div>
        <div className="info-row">
          <b>type + enter (root)</b> spawn a sub-orb
        </div>
        <div className="info-row">
          <b>click sub-orb</b> open chat window
        </div>
        <div className="info-row">
          <b>type + enter (sub)</b> chat with the sub-orb
        </div>
        <div className="info-row">
          <b>📌 in window</b> pin to monitor from main menu
        </div>
        <div className="info-row">
          <b>← back / esc</b> exit one level
        </div>
      </div>
    </div>
  );
}

// must match the panel transition duration in styles.css
const PANEL_TRANSITION_MS = 400;

/** Spatial-zoom phase machine:
 *  - 'idle': panel sits at center (or unmounted if no currentOrbId).
 *  - 'closing': panel collapsing to transitionOrigin; we'll unmount it
 *    afterward and lerp viewT back to 0 (ring view).
 *  - 'transitioning': panel collapsing, content swaps, panel re-expands.
 *    viewT stays at 1 — we're moving between orchestrators, not exiting.
 */
export type Phase = 'idle' | 'closing' | 'transitioning';

export function App() {
  const [orbs, setOrbs] = useState<Map<string, Orb>>(new Map());
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  // Structured run events per orb id — tool_use, tool_result, error,
  // done. Used by the CodeOrchestrator (and any future surface that
  // wants to render the agent's actions as a terminal log) so they
  // don't have to re-parse the textual stream. Reset on `thinking`.
  const [runEvents, setRunEvents] = useState<Map<string, RunEvent[]>>(new Map());
  // memory by orb id — own items live here. Inherited items are
  // computed by walking parent_id at render time, so we don't store
  // them separately.
  const [memory, setMemory] = useState<Map<string, MemoryItem[]>>(new Map());

  const [currentOrbId, setCurrentOrbId] = useState<string | null>(null);
  const [transitionOrigin, setTransitionOrigin] = useState<ScreenPos | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  // Suborb chat windows. The visible set is the union of:
  //   - openWindowIds (transient — opened by clicking a suborb)
  //   - all orbs with `pinned: true` (persistent — survive across views)
  // Closing a window via X removes it from openWindowIds AND unpins
  // the orb, so the window disappears completely.
  const [openWindowIds, setOpenWindowIds] = useState<Set<string>>(new Set());
  // Initial screen position per opened window — set when the user
  // clicks a suborb so the chat box opens centered on the orb. Cleared
  // when the window is closed; survives pin toggling.
  const [windowInitialPos, setWindowInitialPos] = useState<Map<string, ScreenPos>>(
    new Map(),
  );
  // Persisted size + position per orb_id. Survives pin toggles and
  // ring↔agent view trips so a window opens at the same place/size the
  // user last had it. Updated by SuborbWindow on drag-end (mouseup) and
  // on a debounced ResizeObserver tick.
  const [windowStates, setWindowStates] = useState<
    Map<string, { x: number; y: number; w: number; h: number }>
  >(new Map());

  const updateWindowState = useCallback(
    (id: string, state: { x: number; y: number; w: number; h: number }) => {
      setWindowStates((prev) => {
        const cur = prev.get(id);
        if (cur && cur.x === state.x && cur.y === state.y && cur.w === state.w && cur.h === state.h) {
          return prev; // no change — skip the re-render
        }
        const next = new Map(prev);
        next.set(id, state);
        return next;
      });
    },
    [],
  );

  // mouse position in NDC, updated by a window listener. Refs (not state)
  // because we don't want a re-render every mouse-move.
  const mouseRef = useRef<MousePos>({ x: 0, y: 0 });
  // viewT mirror — Scene's ViewTLerp writes the live value here each
  // frame so DOM overlays (suborb windows) can fade out as we leave
  // ring view.
  const viewTRef = useRef(0);
  // each visible orb's current screen-pixel position, updated each
  // frame by OrbMesh. SuborbWindow reads the ROOT orb's entry to
  // anchor a pinned window in the top-left of that orb.
  const orbScreenPosRef = useRef<Map<string, ScreenPos>>(new Map());

  // hydrate from REST on mount (WS snapshot also rebroadcasts on connect)
  useEffect(() => {
    listOrbs()
      .then((list) => setOrbs(new Map(list.map((o) => [o.id, o]))))
      .catch((e) => console.warn('hydrate failed:', e));
  }, []);

  // ws subscription
  const onEvent = useCallback((ev: ServerEvent) => {
    if (ev.type === 'snapshot') {
      setOrbs(new Map(ev.orbs.map((o) => [o.id, o])));
      setMessages(new Map(Object.entries(ev.messages)));
      setMemory(new Map(Object.entries(ev.memory ?? {})));
      return;
    }
    if (ev.type === 'orb_created') {
      setOrbs((prev) => {
        const next = new Map(prev);
        next.set(ev.orb.id, ev.orb);
        return next;
      });
      setMessages((prev) => {
        if (prev.has(ev.orb.id)) return prev;
        const next = new Map(prev);
        next.set(ev.orb.id, []);
        return next;
      });
      return;
    }
    if (ev.type === 'orb_updated') {
      setOrbs((prev) => {
        const cur = prev.get(ev.id);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(ev.id, { ...cur, ...ev.patch });
        return next;
      });
      return;
    }
    if (ev.type === 'orb_deleted') {
      setOrbs((prev) => {
        const next = new Map(prev);
        next.delete(ev.id);
        return next;
      });
      setMessages((prev) => {
        const next = new Map(prev);
        next.delete(ev.id);
        return next;
      });
      setStreams((prev) => {
        const next = new Map(prev);
        next.delete(ev.id);
        return next;
      });
      setRunEvents((prev) => {
        const next = new Map(prev);
        next.delete(ev.id);
        return next;
      });
      setMemory((prev) => {
        const next = new Map(prev);
        next.delete(ev.id);
        return next;
      });
      // if the deleted orb was the one we were looking at, bail to ring
      setCurrentOrbId((cur) => (cur === ev.id ? null : cur));
      return;
    }
    if (ev.type === 'memory_added') {
      setMemory((prev) => {
        const next = new Map(prev);
        const arr = next.get(ev.item.orb_id) || [];
        next.set(ev.item.orb_id, [...arr, ev.item]);
        return next;
      });
      return;
    }
    if (ev.type === 'message_added') {
      setMessages((prev) => {
        const next = new Map(prev);
        const arr = next.get(ev.message.orb_id) || [];
        next.set(ev.message.orb_id, [...arr, ev.message]);
        return next;
      });
      return;
    }
    if (ev.type === 'run_event') {
      // `thinking` resets the per-orb stream buffer + structured event
      // log so a re-run (continued chat) doesn't show stale state
      // while waiting for the first new chunk.
      if (ev.event.kind === 'thinking') {
        setStreams((prev) => {
          const next = new Map(prev);
          next.set(ev.orb_id, '');
          return next;
        });
        setRunEvents((prev) => {
          const next = new Map(prev);
          next.set(ev.orb_id, []);
          return next;
        });
        return;
      }
      if (ev.event.kind === 'output_chunk' && ev.event.text) {
        const text = ev.event.text;
        setStreams((prev) => {
          const next = new Map(prev);
          const cur = next.get(ev.orb_id) || '';
          next.set(ev.orb_id, cur + text);
          return next;
        });
      }
      // Structured events (tool_use / tool_result / error / done) are
      // accumulated separately. The CodeOrchestrator (Task 6) renders
      // them in a terminal-style log; the chat-window stream view also
      // surfaces a textual placeholder so chat orbs that use tools
      // still show *something* without the structured renderer.
      if (
        ev.event.kind === 'tool_use' ||
        ev.event.kind === 'tool_result' ||
        ev.event.kind === 'error' ||
        ev.event.kind === 'done'
      ) {
        setRunEvents((prev) => {
          const next = new Map(prev);
          const arr = next.get(ev.orb_id) || [];
          next.set(ev.orb_id, [...arr, ev.event]);
          return next;
        });
        // mirror as a small text annotation in the running stream
        // so chat-style surfaces still see SOMETHING happening when
        // tool calls fire.
        if (ev.event.kind === 'tool_use') {
          const inputRepr = ev.event.input
            ? JSON.stringify(ev.event.input).slice(0, 200)
            : '';
          const line = `\n[tool: ${ev.event.name ?? '?'}(${inputRepr})]\n`;
          setStreams((prev) => {
            const next = new Map(prev);
            const cur = next.get(ev.orb_id) || '';
            next.set(ev.orb_id, cur + line);
            return next;
          });
        } else if (ev.event.kind === 'tool_result') {
          let repr = '';
          try {
            repr = JSON.stringify(ev.event.output).slice(0, 240);
          } catch {
            repr = String(ev.event.output).slice(0, 240);
          }
          const line = `[result: ${repr}]\n`;
          setStreams((prev) => {
            const next = new Map(prev);
            const cur = next.get(ev.orb_id) || '';
            next.set(ev.orb_id, cur + line);
            return next;
          });
        }
      }
      return;
    }
  }, []);
  useWS(onEvent);

  // window-level mouse for parallax
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouseRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseRef.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // -------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------

  const summon = useCallback(async () => {
    try {
      await createOrb('orb');
    } catch (err) {
      console.warn('summon failed:', err);
    }
  }, []);

  /** Click on an orb (in 3D or in the orb chart). Roots get the
   *  spatial-zoom orchestrator panel. Suborbs get a floating chat
   *  window opened "right on top of" the orb (centered on screenPos). */
  const handleSelect = (orb: Orb, screenPos: ScreenPos) => {
    if (orb.status === 'working') return;
    if (orb.parent_id === null) {
      if (phase !== 'idle' || currentOrbId) return;
      setTransitionOrigin(screenPos);
      setCurrentOrbId(orb.id);
    } else {
      openSuborbWindow(orb.id, screenPos);
    }
  };

  const openSuborbWindow = useCallback((id: string, screenPos?: ScreenPos) => {
    setOpenWindowIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    if (screenPos) {
      setWindowInitialPos((prev) => {
        const next = new Map(prev);
        next.set(id, screenPos);
        return next;
      });
    }
  }, []);

  const closeSuborbWindow = useCallback((id: string) => {
    setOpenWindowIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // optimistic local pin clear so the window disappears immediately
    setOrbs((prev) => {
      const cur = prev.get(id);
      if (!cur || !cur.pinned) return prev;
      const next = new Map(prev);
      next.set(id, { ...cur, pinned: false });
      return next;
    });
    // forget initial pos and persisted size — X means "reset, next time
    // opens fresh"
    setWindowInitialPos((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setWindowStates((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    patchOrb(id, { pinned: false }).catch((e) =>
      console.warn('close patch failed:', e),
    );
  }, []);

  const handleClose = useCallback(() => {
    if (!currentOrbId) return;
    if (phase !== 'idle') return;
    const cur = orbs.get(currentOrbId);
    if (!cur) return;

    if (cur.parent_id) {
      // up one level — collapse, swap content, re-expand
      setPhase('transitioning');
      window.setTimeout(() => {
        setCurrentOrbId(cur.parent_id);
        setPhase('idle');
      }, PANEL_TRANSITION_MS);
    } else {
      // exit to ring view — collapse, unmount
      setPhase('closing');
      window.setTimeout(() => {
        setCurrentOrbId(null);
        setPhase('idle');
      }, PANEL_TRANSITION_MS);
    }
  }, [currentOrbId, phase, orbs]);

  // (The old "recurse into sub-orb's orchestrator panel" handler is
  //  gone. Suborbs use chat windows now. To get a full orchestrator
  //  panel for a suborb, promote it first — it becomes a root.)

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteOrb(id);
    } catch (err) {
      console.warn('delete failed:', err);
    }
  }, []);

  const handleTogglePin = useCallback(
    async (id: string) => {
      const cur = orbs.get(id);
      if (!cur) return;
      try {
        await patchOrb(id, { pinned: !cur.pinned });
      } catch (err) {
        console.warn('pin toggle failed:', err);
      }
    },
    [orbs],
  );

  /** Merge ↑ — saves the current suborb's prompt + result onto the
   *  parent's memory. Future suborbs spawned in the parent will inherit
   *  this finding via the agent's system-prompt walk-up. */
  const handleMergeUp = useCallback(
    async (suborb: Orb) => {
      if (!suborb.parent_id || !suborb.result) return;
      try {
        await addMemory(suborb.parent_id, {
          text: suborb.result,
          kind: 'integrated',
          prompt: suborb.prompt ?? undefined,
          source_orb_id: suborb.id,
          source_orb_name: suborb.display_name || null,
        });
      } catch (err) {
        console.warn('merge failed:', err);
      }
    },
    [],
  );

  /** Promote — detaches a suborb from its parent, making it a root.
   *  Its descendants travel with it (they reference it via parent_id,
   *  which is unchanged).
   *
   *  Also: roots aren't pinnable in this system, so promotion implies
   *  unpinning. We also close any open chat window for this orb since
   *  roots use the orchestrator panel, not chat windows. Both updates
   *  happen optimistically so the UI doesn't show a stale "pinned
   *  summary under the old orchestrator" while the WS catches up. */
  const handlePromote = useCallback(async (id: string) => {
    setOrbs((prev) => {
      const cur = prev.get(id);
      if (!cur) return prev;
      if (cur.parent_id === null && !cur.pinned) return prev;
      const next = new Map(prev);
      next.set(id, { ...cur, parent_id: null, pinned: false });
      return next;
    });
    setOpenWindowIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setWindowInitialPos((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await patchOrb(id, { parent_id: null, pinned: false });
    } catch (err) {
      console.warn('promote failed:', err);
    }
  }, []);

  // keyboard: spacebar summons, escape exits
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')
      )
        return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        summon();
      } else if (e.key === 'Escape') {
        if (currentOrbId) handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentOrbId, summon, handleClose]);

  const orbsArr = useMemo(() => Array.from(orbs.values()), [orbs]);
  const currentOrb = currentOrbId ? orbs.get(currentOrbId) ?? null : null;
  const currentMessages = currentOrbId ? messages.get(currentOrbId) || [] : [];
  // inAgentView = there's a current orb AND we're not actively closing
  // (during 'transitioning' we still want viewT held at 1).
  const inAgentView = currentOrbId !== null && phase !== 'closing';

  /** Orb ids whose 3D mesh should be hidden because their chat window
   *  is open. The window IS the suborb's manifestation while open —
   *  the orb "breaks" into the window and re-materializes when the
   *  window closes. */
  const orbsWithOpenWindow = useMemo(() => {
    const ids = new Set<string>(openWindowIds);
    for (const o of orbsArr) {
      if (o.pinned) ids.add(o.id);
    }
    return ids;
  }, [openWindowIds, orbsArr]);

  /** Pinned suborbs grouped by root id. One PinnedSummary card per
   *  root that has any pinned descendants. Visible only in ring view. */
  const pinnedByRoot = useMemo(() => {
    const map = new Map<string, Orb[]>();
    for (const o of orbsArr) {
      if (!o.pinned) continue;
      // walk to find this orb's root
      let cur: Orb | undefined = o;
      while (cur && cur.parent_id) {
        const parent = orbs.get(cur.parent_id);
        if (!parent) break;
        cur = parent;
      }
      if (!cur) continue;
      const arr = map.get(cur.id) ?? [];
      arr.push(o);
      map.set(cur.id, arr);
    }
    return map;
  }, [orbsArr, orbs]);

  /** Clear transient (unpinned) windows the moment we LEAVE agent
   *  view — at the instant the user clicks Back, not at the end of
   *  the close animation. Pinned suborbs aren't cleared here (they
   *  remain in `orbs` with `pinned: true`); their chat-window mount
   *  fades via viewT and is replaced by the PinnedSummary card. */
  useEffect(() => {
    if (!inAgentView) {
      setOpenWindowIds((prev) => (prev.size === 0 ? prev : new Set()));
      setWindowInitialPos((prev) => (prev.size === 0 ? prev : new Map()));
    }
  }, [inAgentView]);

  return (
    <>
      <Scene
        orbs={orbsArr}
        currentOrbId={currentOrbId}
        inAgentView={inAgentView}
        mouseRef={mouseRef}
        viewTRef={viewTRef}
        orbScreenPosRef={orbScreenPosRef}
        onSelect={handleSelect}
        onSummon={summon}
        onDelete={handleDelete}
      />

      <InfoMenu />
      <OrbChart
        orbs={orbsArr}
        currentOrbId={currentOrbId}
        onSelect={(o) => {
          // Only roots are clickable from the chart (suborbs are inert).
          // Open the orchestrator panel — animates from the chart's
          // top-right region.
          if (o.status === 'working') return;
          if (phase !== 'idle' || currentOrbId) return;
          const origin = { x: window.innerWidth - 80, y: 80 };
          setTransitionOrigin(origin);
          setCurrentOrbId(o.id);
        }}
      />

      {/* Suborb chat windows. ALL windows render here (both transient
        * and pinned) so toggling pin doesn't unmount/remount the
        * component — that previously lost drag offsets, input text,
        * scroll position, etc., which made pinning feel broken.
        *
        * Transient windows flow in the flex container (stacked top-left).
        * Pinned windows get the .floating class which switches them to
        * position: fixed so they're taken out of the flex flow and an
        * rAF loop anchors them to their orb's projected screen pos. */}
      {/* Chat windows render ONLY in agent view, AND only for suborbs
        * whose root === the current orchestrator. A pinned suborb of
        * root A doesn't follow you into root B's orchestrator — it
        * waits until you come back to A. */}
      <div className="suborb-windows">
        {inAgentView &&
          currentOrbId &&
          (() => {
            const rootOf = (orb: Orb): string => {
              let cur: Orb | undefined = orb;
              while (cur && cur.parent_id) {
                const parent = orbs.get(cur.parent_id);
                if (!parent) break;
                cur = parent;
              }
              return cur ? cur.id : orb.id;
            };
            const ids = new Set<string>();
            for (const id of openWindowIds) {
              const o = orbs.get(id);
              if (o && rootOf(o) === currentOrbId) ids.add(id);
            }
            for (const o of orbsArr) {
              if (o.pinned && rootOf(o) === currentOrbId) ids.add(o.id);
            }
            return Array.from(ids)
              .map((id) => orbs.get(id))
              .filter((o): o is Orb => !!o)
              .map((o) => (
                <SuborbWindow
                  key={o.id}
                  orb={o}
                  messages={messages.get(o.id) || []}
                  streams={streams}
                  initialPos={windowInitialPos.get(o.id) ?? null}
                  persistedState={windowStates.get(o.id) ?? null}
                  onStateChange={(s) => updateWindowState(o.id, s)}
                  floating={o.pinned}
                  orbsById={orbs}
                  viewTRef={viewTRef}
                  orbScreenPosRef={orbScreenPosRef}
                  onClose={() => closeSuborbWindow(o.id)}
                  onTogglePin={() => handleTogglePin(o.id)}
                  onMergeUp={handleMergeUp}
                  onPromote={handlePromote}
                />
              ));
          })()}
      </div>

      {/* Ring-view summary cards — one per root with any pinned
        * suborbs. Anchored to the root's projected screen position
        * (top-left of the orb). Cross-fades with the SuborbWindow:
        * chat windows visible in agent view, summaries in ring view. */}
      {Array.from(pinnedByRoot.entries()).map(([rootId, suborbs]) => {
        const rootOrb = orbs.get(rootId);
        if (!rootOrb) return null;
        return (
          <PinnedSummary
            key={rootId}
            rootOrb={rootOrb}
            pinnedSuborbs={suborbs}
            streams={streams}
            viewTRef={viewTRef}
            orbScreenPosRef={orbScreenPosRef}
            onClickRoot={(r) => {
              if (phase !== 'idle' || currentOrbId) return;
              const origin = orbScreenPosRef.current.get(r.id) ?? {
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
              };
              setTransitionOrigin(origin);
              setCurrentOrbId(r.id);
            }}
          />
        );
      })}

      {currentOrb && transitionOrigin && (
        <Panel
          orb={currentOrb}
          messages={currentMessages}
          orbsById={orbs}
          streams={streams}
          runEvents={runEvents}
          memory={memory}
          transitionOrigin={transitionOrigin}
          phase={phase}
          onClose={handleClose}
          onOpenSuborbWindow={openSuborbWindow}
          onDelete={handleDelete}
          onMergeUp={handleMergeUp}
          onPromote={handlePromote}
        />
      )}
    </>
  );
}
