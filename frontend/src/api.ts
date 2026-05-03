// Tiny typed REST client + WebSocket hook.

import { useEffect, useRef } from 'react';

export type OrbKind = 'orb' | 'suborb';
export type OrbStatus = 'idle' | 'working' | 'done' | 'failed';
export type MemoryKind = 'note' | 'integrated' | 'context';
export type AgentType = 'chat' | 'code' | 'research' | 'computer' | 'voice';

export interface Orb {
  id: string;
  parent_id: string | null;
  user_id: string;
  kind: OrbKind;
  display_name: string;
  prompt: string | null;
  result: string | null;
  status: OrbStatus;
  pinned: boolean;
  agent_type: AgentType;
  agent_config: Record<string, unknown>;
  instructions?: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  orb_id: string;
  role: 'user' | 'agent' | 'spawn';
  content: string | null;
  spawned_orb_id: string | null;
  created_at: string;
}

export interface MemoryItem {
  id: string;
  orb_id: string;
  kind: MemoryKind;
  text: string;
  prompt?: string | null;
  source_orb_id?: string | null;
  source_orb_name?: string | null;
  created_at: string;
}

/** Inherited memory item, enriched with the depth and source name from
 *  the ancestor walk. Returned by GET /api/orbs/:id/memory/inherited. */
export interface InheritedMemoryItem {
  item: MemoryItem;
  depth: number; // 0 = own; 1 = parent; 2 = grandparent...
  source_name: string;
}

// Transient events emitted while a suborb is running. The backend may
// add more kinds over time (tool_use / tool_result for v1+).
export type RunEventKind =
  | 'thinking'
  | 'output_chunk'
  | 'tool_use'
  | 'tool_result'
  | 'done'
  | 'error';

export interface RunEvent {
  kind: RunEventKind;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export type ServerEvent =
  | {
      type: 'snapshot';
      orbs: Orb[];
      messages: Record<string, Message[]>;
      memory: Record<string, MemoryItem[]>;
    }
  | { type: 'orb_created'; orb: Orb }
  | { type: 'orb_updated'; id: string; patch: Partial<Orb> }
  | { type: 'orb_deleted'; id: string }
  | { type: 'message_added'; message: Message }
  | { type: 'memory_added'; item: MemoryItem }
  | { type: 'run_event'; orb_id: string; event: RunEvent };

const apiBase = ''; // vite proxy handles it

export async function listOrbs(): Promise<Orb[]> {
  const r = await fetch(`${apiBase}/api/orbs`);
  if (!r.ok) throw new Error(`listOrbs ${r.status}`);
  return r.json();
}

export async function createOrb(
  display_name: string,
  opts: { agent_type?: AgentType; agent_config?: Record<string, unknown> } = {},
): Promise<Orb> {
  const r = await fetch(`${apiBase}/api/orbs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name,
      agent_type: opts.agent_type ?? 'chat',
      agent_config: opts.agent_config ?? {},
    }),
  });
  if (!r.ok) throw new Error(`createOrb ${r.status}`);
  return r.json();
}

export async function deleteOrb(id: string): Promise<void> {
  const r = await fetch(`${apiBase}/api/orbs/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`deleteOrb ${r.status}`);
}

export async function patchOrb(
  id: string,
  body: Partial<Pick<Orb, 'pinned' | 'display_name' | 'parent_id' | 'agent_type' | 'agent_config' | 'instructions'>>,
): Promise<Orb> {
  const r = await fetch(`${apiBase}/api/orbs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patchOrb ${r.status}`);
  return r.json();
}

export async function listInheritedMemory(orb_id: string): Promise<InheritedMemoryItem[]> {
  const r = await fetch(`${apiBase}/api/orbs/${orb_id}/memory/inherited`);
  if (!r.ok) throw new Error(`listInheritedMemory ${r.status}`);
  return r.json();
}

export async function addMemory(
  orb_id: string,
  body: {
    text: string;
    kind?: MemoryKind;
    prompt?: string | null;
    source_orb_id?: string | null;
    source_orb_name?: string | null;
  },
): Promise<MemoryItem> {
  const r = await fetch(`${apiBase}/api/orbs/${orb_id}/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`addMemory ${r.status}`);
  return r.json();
}

export async function sendMessage(orb_id: string, content: string): Promise<{ suborb_id: string }> {
  const r = await fetch(`${apiBase}/api/orbs/${orb_id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`sendMessage ${r.status}`);
  return r.json();
}

/** Subscribe to the backend WS event stream. Reconnects on close. */
export function useWS(onEvent: (e: ServerEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let timer: number | null = null;

    const connect = () => {
      if (!alive) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as ServerEvent;
          handlerRef.current(data);
        } catch (err) {
          console.warn('bad ws payload', err);
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        timer = window.setTimeout(connect, 800);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
