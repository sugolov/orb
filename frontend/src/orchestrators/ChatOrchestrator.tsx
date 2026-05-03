// Chat orchestrator surface — the dispatcher.
//
// IMPORTANT: this surface is no longer a "chat" in the conversational
// sense. The orchestrator does not reply to the user. Its center
// column is a DISPATCH LOG: a chronological list of cards, one per
// suborb spawned at this level. Each card shows the prompt that
// spawned it + the suborb's status. Click a card → opens that
// suborb's floating chat window (where the actual conversation lives).
//
// Layout: three columns — Memory left, Dispatch log center, Sub-orbs
// visualization right (currently merged into the chat list; broken
// out fully in a follow-up). Bottom: a "dispatch a task…" input that
// will gain a per-dispatch agent-backend selector in Task 4.

import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryItem, Message, Orb, OrbStatus } from '../api';
import { sendMessage } from '../api';
import { agentTypeOf } from '../agentTypes';
import type { OrchestratorProps } from '../OrchestratorPanel';

function breadcrumb(orb: Orb, orbsById: Map<string, Orb>): Orb[] {
  const chain: Orb[] = [];
  let cur: Orb | undefined = orb;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_id ? orbsById.get(cur.parent_id) : undefined;
  }
  return chain;
}

interface RenderedMemory {
  id: string;
  source: string;       // ancestor name; '' for own items
  depth: number;        // 0 = own
  item: MemoryItem;
}

/** Walk this orb's ancestor chain and produce a flat list of memory
 *  items annotated with depth + source. Plus the orb's own items at
 *  depth 0. Order: deepest ancestor first → own (so the user sees
 *  inherited context above their own notes). */
function gatherMemory(
  orb: Orb,
  orbsById: Map<string, Orb>,
  memoryByOrb: Map<string, MemoryItem[]>,
): RenderedMemory[] {
  const out: RenderedMemory[] = [];
  // walk ancestors (root → parent)
  const ancestors: Orb[] = [];
  let cur: Orb | undefined = orb.parent_id ? orbsById.get(orb.parent_id) : undefined;
  while (cur) {
    ancestors.unshift(cur);
    cur = cur.parent_id ? orbsById.get(cur.parent_id) : undefined;
  }
  for (const anc of ancestors) {
    const items = memoryByOrb.get(anc.id) || [];
    const depth = ancestors.length - ancestors.indexOf(anc);
    for (const item of items) {
      out.push({ id: item.id, source: anc.display_name || 'unnamed', depth, item });
    }
  }
  for (const item of memoryByOrb.get(orb.id) || []) {
    out.push({ id: item.id, source: '', depth: 0, item });
  }
  return out;
}

export function ChatOrchestrator({
  orb,
  messages,
  orbsById,
  streams,
  memory,
  transitionOrigin,
  phase,
  onClose,
  onOpenSuborbWindow,
  onDelete,
  onMergeUp,
  onPromote,
}: OrchestratorProps) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mergeFlash, setMergeFlash] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setMounted(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  const isOpen = mounted && phase === 'idle';

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [orb.id, isOpen]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streams]);

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

  const crumbs = breadcrumb(orb, orbsById);
  const renderedMemory = useMemo(
    () => gatherMemory(orb, orbsById, memory),
    [orb, orbsById, memory],
  );
  const subOrbCount = useMemo(
    () => Array.from(orbsById.values()).filter((o) => o.parent_id === orb.id).length,
    [orbsById, orb.id],
  );
  const isSuborb = orb.parent_id !== null;
  const canMerge = isSuborb && orb.status === 'done' && !!orb.result;

  /** Build the dispatch-log entries from this orb's chat history.
   *  Walk messages in order; for each `spawn` marker we pair it with
   *  the immediately-preceding `user` message (which is the prompt
   *  that spawned it). The dispatch card uses that prompt as its
   *  primary content. Lonely user messages and orphan agent messages
   *  are skipped — orchestrators don't have their own chat thread in
   *  the dispatcher reframe; conversation lives in suborbs. */
  const dispatches = useMemo(() => {
    const out: Array<{
      id: string;
      prompt: string;
      suborb: Orb | undefined;
      status: OrbStatus;
      stream: string;
    }> = [];
    let pendingUser: Message | null = null;
    for (const m of messages) {
      if (m.role === 'user') {
        pendingUser = m;
      } else if (m.role === 'spawn' && m.spawned_orb_id) {
        const sub = orbsById.get(m.spawned_orb_id);
        const promptText =
          (pendingUser?.content || sub?.prompt || '').trim() || '(no prompt)';
        out.push({
          id: m.id,
          prompt: promptText,
          suborb: sub,
          status: sub?.status ?? 'working',
          stream: streams.get(m.spawned_orb_id) || '',
        });
        pendingUser = null;
      } else {
        // any other role (e.g. legacy 'agent' from earlier behavior) —
        // just clear pending so it doesn't leak into the next dispatch
        pendingUser = null;
      }
    }
    return out;
  }, [messages, orbsById, streams]);

  const style: CSSProperties = isOpen
    ? {
        left: '50%',
        top: subOrbCount > 0 ? 'calc(50% + 170px)' : 'calc(50% + 130px)',
        transform: 'translate(-50%, -50%) scale(1)',
        opacity: 1,
      }
    : {
        left: `${transitionOrigin.x}px`,
        top: `${transitionOrigin.y}px`,
        transform: 'translate(-50%, -50%) scale(0.05)',
        opacity: 0,
        pointerEvents: 'none',
      };

  const triggerMerge = () => {
    onMergeUp(orb);
    setMergeFlash(true);
    setTimeout(() => setMergeFlash(false), 600);
  };

  return (
    <div className={`panel ${mergeFlash ? 'merge-flash' : ''}`} style={style}>
      <div className="panel-header">
        <button className="hbtn" onClick={onClose} title="Back">
          ← Back
        </button>
        <div className="panel-title">
          {crumbs.map((c, i) => (
            <span key={c.id}>
              <span className={i === crumbs.length - 1 ? 'crumb-current' : 'crumb'}>
                {c.display_name || '…'}
              </span>
              {i < crumbs.length - 1 && <span className="crumb-sep">›</span>}
            </span>
          ))}
        </div>
        {orb.status === 'working' && <div className="panel-status busy">thinking</div>}

        {/* note: orchestrators are NOT pinnable — pinning is a suborb-
         *  only affordance (via the suborb chat window). */}

        {/* merge ↑ — only for suborbs that have produced a result */}
        {canMerge && (
          <button
            className="hbtn teal"
            onClick={triggerMerge}
            title="save this finding into the parent's memory"
          >
            ↑ merge
          </button>
        )}

        {/* promote — only for suborbs (root orbs can't promote) */}
        {isSuborb && (
          <button
            className="hbtn teal"
            onClick={() => onPromote(orb.id)}
            title="detach this orb to become its own root"
          >
            ⇈ promote
          </button>
        )}

        <button
          className="hbtn dismiss"
          onClick={() => {
            if (confirm(`delete "${orb.display_name || 'this orb'}" and its sub-orbs?`)) {
              onDelete(orb.id);
            }
          }}
          title="delete this orb"
        >
          ✕
        </button>
      </div>

      <div className="panel-body">
        <aside className="memory-col">
          <div className="col-title">Memory</div>
          <div className="col-list">
            {renderedMemory.length === 0 && (
              <div className="mem-empty">no memory yet</div>
            )}
            {renderedMemory.map((m) => {
              const cls = `mem-item ${m.depth > 0 ? 'inherited' : 'own'} ${m.item.kind}`;
              return (
                <div key={m.id} className={cls}>
                  <div className="mem-meta">
                    <span className="mem-kind">{m.item.kind}</span>
                    {m.source && <span className="mem-src">↑ {m.source}</span>}
                  </div>
                  {m.item.kind === 'integrated' && m.item.prompt && (
                    <div className="mem-prompt">asked: {m.item.prompt}</div>
                  )}
                  <div className="mem-text">{m.item.text}</div>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="chat-col">
          <div className="messages dispatch-log" ref={messagesRef}>
            {dispatches.length === 0 && (
              <div className="dispatch-empty">
                no dispatches yet — type a task below to spawn a sub-orb.
                each dispatch becomes its own agent; click a card to chat.
              </div>
            )}
            {dispatches.map((d) => {
              const sub = d.suborb;
              const subType = agentTypeOf(sub ?? orb);
              const status = d.status;
              const liveText =
                status === 'done'
                  ? sub?.result || ''
                  : status === 'failed'
                  ? sub?.result || 'failed'
                  : d.stream;
              return (
                <div
                  key={d.id}
                  className={`dispatch ${status}`}
                  onClick={(e) => {
                    if (sub)
                      onOpenSuborbWindow(sub.id, { x: e.clientX, y: e.clientY });
                  }}
                  style={{
                    // type-tinted left border so each card carries its
                    // backend's color even before any UI does anything
                    borderLeftColor: subType.cssAccent,
                  }}
                >
                  <div className="dispatch-row">
                    <span className={`dispatch-dot status-${status}`} />
                    <span className="dispatch-prompt">{d.prompt}</span>
                    <span className="dispatch-status">
                      {status === 'working' && 'thinking…'}
                      {status === 'done' && (sub?.display_name || 'done')}
                      {status === 'failed' && 'failed'}
                    </span>
                  </div>
                  {liveText && (
                    <div className="dispatch-preview">{liveText}</div>
                  )}
                  <div className="dispatch-meta">
                    <span className="dispatch-type">{subType.label.toLowerCase()}</span>
                    <span className="dispatch-action">click to chat →</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="input-row dispatch-input">
            <span className="input-prompt">›</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="dispatch a task…"
              disabled={submitting || !isOpen}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
