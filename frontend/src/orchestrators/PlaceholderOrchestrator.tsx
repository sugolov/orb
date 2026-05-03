// Generic stub orchestrator for agent types whose real surface
// hasn't shipped yet (research / computer / voice). Renders the
// shared panel shell (header, back button, transition origin
// animation) with a type-colored accent border and a custom
// "coming soon" body sketch. Dispatch input still works — the user
// can spawn a sub-orb of this type and see streaming output via
// whatever backend the registry resolves (echo as fallback).
//
// Once a concrete orchestrator ships for one of these types, replace
// the wrapper that delegates here with the real component.

import {
  CSSProperties,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { sendMessage } from '../api';
import { agentTypeOf } from '../agentTypes';
import type { OrchestratorProps } from '../OrchestratorPanel';

interface PlaceholderProps extends OrchestratorProps {
  /** Sketch of the planned body — small piece of JSX shown in the
   *  empty state. Each stub passes its own. */
  bodySketch: ReactNode;
  /** Placeholder text for the dispatch input (per-type framing). */
  inputPlaceholder: string;
  /** Optional extra css class on the panel root for type-specific
   *  styling tweaks (e.g. accent-tinted border). */
  panelClass?: string;
}

export function PlaceholderOrchestrator({
  orb,
  orbsById,
  transitionOrigin,
  phase,
  onClose,
  onDelete,
  onMergeUp,
  onPromote,
  bodySketch,
  inputPlaceholder,
  panelClass = '',
}: PlaceholderProps) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mounted, setMounted] = useState(false);
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

  const crumbs: typeof orb[] = [];
  let cur: typeof orb | undefined = orb;
  while (cur) {
    crumbs.unshift(cur);
    cur = cur.parent_id ? orbsById.get(cur.parent_id) : undefined;
  }

  const isSuborb = orb.parent_id !== null;
  const canMerge = isSuborb && orb.status === 'done' && !!orb.result;
  const typeDef = agentTypeOf(orb);

  const style: CSSProperties = isOpen
    ? {
        left: '50%',
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
    <div
      className={`panel placeholder-panel ${panelClass}`}
      style={{
        ...style,
        ['--type-accent' as string]: typeDef.cssAccent,
      }}
    >
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
        <span className="placeholder-tag" style={{ color: typeDef.cssAccent }}>
          {typeDef.label}
        </span>
        {orb.status === 'working' && (
          <div className="panel-status busy">working</div>
        )}
        {canMerge && (
          <button className="hbtn teal" onClick={() => onMergeUp(orb)} title="merge">
            ↑ merge
          </button>
        )}
        {isSuborb && (
          <button className="hbtn teal" onClick={() => onPromote(orb.id)} title="promote">
            ⇈ promote
          </button>
        )}
        <button
          className="hbtn dismiss"
          onClick={() => {
            if (
              confirm(`delete "${orb.display_name || 'this orb'}" and its sub-orbs?`)
            ) {
              onDelete(orb.id);
            }
          }}
          title="delete"
        >
          ✕
        </button>
      </div>

      <div className="panel-body placeholder-body">
        <div className="placeholder-sketch">{bodySketch}</div>
        <div className="input-row">
          <span className="input-prompt">›</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={inputPlaceholder}
            disabled={submitting || !isOpen}
          />
        </div>
      </div>
    </div>
  );
}
