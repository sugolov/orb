// Code orchestrator surface — terminal-style scrollback + dispatch
// input. Per the spec (overnight.md Task 6): no memory column by
// default, no dispatch-card view; instead each dispatched sub-orb
// appears as a collapsible "code block" in the terminal scrollback,
// showing the agent's actions (tool_use → "$ command", tool_result →
// inline output, text chunks → streaming).
//
// Sub-orbs are NOT shown above the panel as floating orbs by default
// for code orchestrators (Scene.tsx checks the parent's
// agent_type.spawnsSuborbsAbovePanel). They're inline here. Pinning
// a code sub-orb still produces a floating chat window via the
// SuborbWindow path — that's the explicit "extract this" gesture.

import {
  CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Message,
  Orb,
  OrbStatus,
  RunEvent,
} from '../api';
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

interface Dispatch {
  id: string;
  prompt: string;
  suborb: Orb | undefined;
  status: OrbStatus;
  stream: string;
  events: RunEvent[];
}

export function CodeOrchestrator({
  orb,
  messages,
  orbsById,
  streams,
  runEvents,
  backends,
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // double-rAF to apply opening transition cleanly (matches Chat
  // orchestrator's pattern). transitionOrigin → centered.
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
  }, [messages, streams, runEvents]);

  const matchingBackends = useMemo(
    () => backends.filter((b) => b.available && b.agent_type === orb.agent_type),
    [backends, orb.agent_type],
  );
  const allAvailable = useMemo(
    () => backends.filter((b) => b.available),
    [backends],
  );
  const [selectedBackendId, setSelectedBackendId] = useState<string>('');
  useEffect(() => {
    if (selectedBackendId) {
      const ok = allAvailable.some((b) => b.id === selectedBackendId);
      if (!ok) setSelectedBackendId('');
      return;
    }
    const real = matchingBackends.find((b) => b.id !== 'echo');
    const fallback = matchingBackends[0] ?? allAvailable[0];
    setSelectedBackendId((real ?? fallback)?.id ?? '');
  }, [matchingBackends, allAvailable, selectedBackendId]);

  const submit = async () => {
    const text = input.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setInput('');
    try {
      await sendMessage(
        orb.id,
        text,
        selectedBackendId ? { backend_id: selectedBackendId } : {},
      );
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** Walk messages, pair `spawn` markers with the preceding `user`
   *  message (the prompt), produce one Dispatch per. The terminal
   *  body renders these as collapsible code blocks. */
  const dispatches = useMemo<Dispatch[]>(() => {
    const out: Dispatch[] = [];
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
          events: runEvents.get(m.spawned_orb_id) || [],
        });
        pendingUser = null;
      } else {
        pendingUser = null;
      }
    }
    return out;
  }, [messages, orbsById, streams, runEvents]);

  const crumbs = breadcrumb(orb, orbsById);
  const isSuborb = orb.parent_id !== null;
  const canMerge = isSuborb && orb.status === 'done' && !!orb.result;
  const subOrbCount = useMemo(
    () => Array.from(orbsById.values()).filter((o) => o.parent_id === orb.id).length,
    [orbsById, orb.id],
  );

  const style: CSSProperties = isOpen
    ? {
        left: '50%',
        // Code panel is the same size/position as chat — sub-orbs
        // don't float above (per the type policy), so we don't push
        // the panel down to make headroom.
        top: 'calc(50% + 130px)',
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

  return (
    <div className="panel code-panel" style={style}>
      <div className="panel-header code-header">
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
        {orb.status === 'working' && (
          <div className="panel-status busy">running</div>
        )}
        {canMerge && (
          <button
            className="hbtn teal"
            onClick={() => onMergeUp(orb)}
            title="save this finding into the orchestrator's memory"
          >
            ↑ merge
          </button>
        )}
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

      <div className="panel-body code-body">
        <div className="code-terminal" ref={messagesRef}>
          {dispatches.length === 0 && (
            <pre className="code-empty">
              {`# code orchestrator — describe a task below.
# each dispatch runs an agent in this orb's working directory.
# tool calls + output appear inline as the agent works.`}
            </pre>
          )}
          {dispatches.map((d) => (
            <CodeBlock
              key={d.id}
              dispatch={d}
              onOpen={(e) =>
                d.suborb &&
                onOpenSuborbWindow(d.suborb.id, { x: e.clientX, y: e.clientY })
              }
            />
          ))}
        </div>
        <div className="input-row code-input-row">
          <select
            className="backend-select"
            value={selectedBackendId}
            onChange={(e) => setSelectedBackendId(e.target.value)}
            title="dispatch backend"
            disabled={submitting || !isOpen || allAvailable.length === 0}
          >
            {matchingBackends.length > 0 && (
              <optgroup label={`${orb.agent_type} agents`}>
                {matchingBackends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.display_name}
                  </option>
                ))}
              </optgroup>
            )}
            {allAvailable
              .filter((b) => b.agent_type !== orb.agent_type)
              .map((b) => (
                <optgroup key={b.id} label={`other (${b.agent_type})`}>
                  <option value={b.id}>{b.display_name}</option>
                </optgroup>
              ))}
          </select>
          <span className="input-prompt code-prompt">$</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="describe a coding task…"
            disabled={submitting || !isOpen}
          />
        </div>
      </div>
    </div>
  );
}

interface CodeBlockProps {
  dispatch: Dispatch;
  onOpen: (e: React.MouseEvent) => void;
}

function CodeBlock({ dispatch, onOpen }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(true);
  const subType = agentTypeOf(dispatch.suborb ?? { agent_type: 'code' as const });
  const status = dispatch.status;
  const hasOutput =
    dispatch.events.length > 0 || dispatch.stream.length > 0;

  return (
    <div
      className={`code-block status-${status}`}
      style={{ borderLeftColor: subType.cssAccent }}
    >
      <div
        className="code-block-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="code-block-marker">{expanded ? '▼' : '▶'}</span>
        <span className="code-block-prompt">{dispatch.prompt}</span>
        <span className={`code-block-status status-${status}`}>
          {status === 'working' ? 'running…' : status}
        </span>
      </div>
      {expanded && (
        <div className="code-block-body">
          {!hasOutput && status === 'working' && (
            <div className="code-line code-thinking">… thinking</div>
          )}
          {dispatch.events.map((event, i) => (
            <CodeEvent key={i} event={event} />
          ))}
          {dispatch.stream && (
            <pre className="code-stream">{dispatch.stream}</pre>
          )}
          {status === 'done' && (
            <div
              className="code-line code-done"
              onClick={onOpen}
              role="button"
            >
              ✓ done — click to open chat
            </div>
          )}
          {status === 'failed' && (
            <div className="code-line code-failed">× failed</div>
          )}
        </div>
      )}
    </div>
  );
}

function CodeEvent({ event }: { event: RunEvent }) {
  if (event.kind === 'tool_use') {
    let inputRepr = '';
    if (event.input) {
      try {
        inputRepr = JSON.stringify(event.input);
        if (inputRepr.length > 200) inputRepr = inputRepr.slice(0, 197) + '…';
      } catch {
        inputRepr = String(event.input);
      }
    }
    return (
      <div className="code-line code-tool-use">
        <span className="code-prompt-glyph">$</span>{' '}
        <span className="code-tool-name">{event.name ?? '?'}</span>
        {inputRepr && (
          <span className="code-tool-input"> {inputRepr}</span>
        )}
      </div>
    );
  }
  if (event.kind === 'tool_result') {
    let repr = '';
    try {
      repr =
        typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output, null, 2);
    } catch {
      repr = String(event.output);
    }
    if (repr.length > 1200) repr = repr.slice(0, 1197) + '…';
    return (
      <pre className="code-line code-tool-result">{repr}</pre>
    );
  }
  if (event.kind === 'error') {
    return (
      <div className="code-line code-failed">× {event.error ?? 'error'}</div>
    );
  }
  return null;
}
