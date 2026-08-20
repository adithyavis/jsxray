import type { Node } from '@xyflow/react';
import type { ScreenNodeData } from './graph.js';

/**
 * §14 — a flow is the part of the app a screen belongs to, which is the same
 * answer the node eyebrow gives. Screens at the root of the app have no parent
 * segment and so no section of their own; they are where the reader starts, so
 * they are named for that rather than left unlabelled.
 */
export const TOP_LEVEL = 'Top level';

export interface Flow {
  id: string;
  label: string;
  nodeIds: string[];
}

/**
 * Built from the nodes actually drawn, so a flow's count is the number of
 * screens on the canvas and never a number from somewhere else.
 */
export function flowsOf(nodes: Node[]): Flow[] {
  const byLabel = new Map<string, string[]>();

  for (const node of nodes) {
    if (node.type !== 'screen') continue;
    const label = (node.data as ScreenNodeData).section ?? TOP_LEVEL;
    const held = byLabel.get(label);
    if (held) held.push(node.id);
    else byLabel.set(label, [node.id]);
  }

  // Insertion order is layout order, which is crawl order — the order the run
  // met these parts of the app, rather than an alphabet that means nothing here.
  return [...byLabel].map(([label, nodeIds]) => ({ id: label, label, nodeIds }));
}
