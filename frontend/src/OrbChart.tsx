// Top-right floating panel showing the live tree of orbs. Each row is
// an orb; nesting reflects parent_id. Status is encoded by a colored
// dot. Pinned orbs get a small pin glyph. Clicking a row navigates to
// that orb (App passes onSelect).
//
// This is a direct visualization of the tree-as-context structure:
// every edge here is a parent_id pointer in the data, and the user
// can read off context inheritance by reading the indentation.

import type { Orb } from './api';

interface OrbChartProps {
  orbs: Orb[];
  currentOrbId: string | null;
  onSelect: (orb: Orb) => void;
}

interface TreeNode {
  orb: Orb;
  children: TreeNode[];
}

function buildTree(orbs: Orb[]): TreeNode[] {
  const childrenByParent = new Map<string | null, Orb[]>();
  for (const o of orbs) {
    const arr = childrenByParent.get(o.parent_id) ?? [];
    arr.push(o);
    childrenByParent.set(o.parent_id, arr);
  }
  const sortByCreated = (a: Orb, b: Orb) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  const make = (o: Orb): TreeNode => ({
    orb: o,
    children: (childrenByParent.get(o.id) ?? []).sort(sortByCreated).map(make),
  });
  return (childrenByParent.get(null) ?? []).sort(sortByCreated).map(make);
}

function statusClass(o: Orb): string {
  if (o.status === 'working') return 'chart-dot working';
  if (o.status === 'failed') return 'chart-dot failed';
  if (o.kind === 'suborb' && o.status === 'done') return 'chart-dot suborb-done';
  return 'chart-dot orb';
}

function ChartNode({
  node,
  currentOrbId,
  onSelect,
}: {
  node: TreeNode;
  currentOrbId: string | null;
  onSelect: (orb: Orb) => void;
}) {
  const isCurrent = node.orb.id === currentOrbId;
  // Only roots (orchestrators) are clickable from the chart. Suborbs
  // are display-only — to interact with one, the user clicks it in 3D
  // (which opens its chat window). To enter a suborb as an
  // orchestrator, promote it (parent_id := null) first.
  const isClickable = node.orb.parent_id === null;
  return (
    <div className="chart-node">
      <div
        className={`chart-row ${isCurrent ? 'current' : ''} ${isClickable ? '' : 'inert'}`}
        onClick={() => {
          if (isClickable) onSelect(node.orb);
        }}
        title={
          isClickable
            ? node.orb.display_name
            : 'sub-orb (click in 3D to open chat; promote to make clickable)'
        }
      >
        <span className={statusClass(node.orb)} />
        <span className="chart-label">{node.orb.display_name || '…'}</span>
        {node.orb.pinned && <span className="chart-pin">📌</span>}
      </div>
      {node.children.length > 0 && (
        <div className="chart-children">
          {node.children.map((c) => (
            <ChartNode
              key={c.orb.id}
              node={c}
              currentOrbId={currentOrbId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OrbChart({ orbs, currentOrbId, onSelect }: OrbChartProps) {
  const tree = buildTree(orbs);
  if (tree.length === 0) return null;
  return (
    <div className="orb-chart">
      <div className="chart-title">Tree</div>
      <div className="chart-body">
        {tree.map((n) => (
          <ChartNode
            key={n.orb.id}
            node={n}
            currentOrbId={currentOrbId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
