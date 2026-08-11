import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';

const elk = new ELK();

/** §14 — the gap between depths carries the edge and its label; siblings only stack. */
const GAP_X = 220;
const GAP_Y = 48;

/**
 * §14 — a tree layout, because every state is a consequence of the one before
 * it. `elk.layered` is the fallback when back-edges make the graph a real DAG.
 */
export async function layoutGraph(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  if (!nodes.length) return nodes;

  const tree = isTree(nodes, edges);
  // `mrtree` spends `spacing.nodeNode` in both directions, so the wider horizontal
  // gap is bought by padding each node instead — the returned x is still its left edge.
  const pad = tree ? GAP_X - GAP_Y : 0;
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': tree ? 'mrtree' : 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(GAP_Y),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(GAP_X),
      'elk.spacing.edgeNode': '32',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.mrtree.searchOrder': 'DFS',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: (node.width ?? 260) + pad,
      height: node.height ?? 240,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const laid = await elk.layout(graph);
  const positions = new Map(
    (laid.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]),
  );

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }));
}

/** One parent per node and no cycles — what `mrtree` needs. */
function isTree(nodes: Node[], edges: Edge[]): boolean {
  const parents = new Map<string, number>();
  for (const edge of edges) {
    if (edge.source === edge.target) return false;
    parents.set(edge.target, (parents.get(edge.target) ?? 0) + 1);
  }
  if ([...parents.values()].some((count) => count > 1)) return false;
  return !hasCycle(nodes, edges);
}

function hasCycle(nodes: Node[], edges: Edge[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };

  return nodes.some((node) => visit(node.id));
}
