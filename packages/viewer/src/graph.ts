import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import type { Edge, Node } from '@xyflow/react';
import { eyebrowOf, screenOf, titleOf, transitionOf } from './document.js';

export type FrameKind = 'browser' | 'phone';

export const FRAME_SIZE: Record<FrameKind, { width: number; height: number }> = {
  browser: { width: 300, height: 232 },
  phone: { width: 176, height: 348 },
};

/** §14 typing note — named fields stay out of the index signature. */
export interface ScreenNodeFields {
  signature: string;
  title: string;
  eyebrow: string | null;
  frame: FrameKind;
  variants: ScreenState[];
  active: ScreenState;
  inbound: number;
  outbound: number;
}

export type ScreenNodeData = ScreenNodeFields & Record<string, unknown>;

export interface GraphInput {
  document: JsxrayDocument;
  personaId: string | null;
  frame: FrameKind;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  /** Traversals that are real but not drawn (see findHiddenLinks). */
  hiddenLinks: number;
}

/**
 * The frame follows the capture, not the framework. An Expo app crawled at a
 * desktop viewport is a desktop screenshot, and drawing it in a phone frame
 * shrinks a real capture to fit a lie about it (§7.2).
 */
export function frameForCaptures(document: JsxrayDocument): FrameKind {
  const captured = document.states.find((state) => state.capture);
  if (captured?.capture) {
    return captured.capture.viewport.width >= captured.capture.viewport.height
      ? 'browser'
      : 'phone';
  }
  return document.framework?.renderTarget === 'native' ? 'phone' : 'browser';
}

export function buildGraph(input: GraphInput): Graph {
  const { document, personaId, frame } = input;

  const bySignature = new Map<string, ScreenState[]>();
  for (const state of document.states) {
    if (personaId && state.personaId !== personaId) continue;
    bySignature.set(state.signature, [...(bySignature.get(state.signature) ?? []), state]);
  }

  const runtimeEdges = document.edges.filter(
    (edge) =>
      edge.discoveredBy === 'runtime' &&
      (!personaId || edge.personaId === personaId) &&
      edge.fromState &&
      edge.toState &&
      bySignature.has(edge.fromState) &&
      bySignature.has(edge.toState),
  );

  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const captionByPair = new Map<string, string>();
  const order: string[] = [];

  for (const edge of runtimeEdges) {
    const pair = `${edge.fromState}->${edge.toState}`;
    outbound.set(edge.fromState!, (outbound.get(edge.fromState!) ?? 0) + 1);
    inbound.set(edge.toState!, (inbound.get(edge.toState!) ?? 0) + 1);
    if (captionByPair.has(pair)) continue;
    order.push(pair);
    // One line per pair, so it is named once — by the transition, not by every
    // control that makes it (§14).
    captionByPair.set(
      pair,
      transitionOf(bySignature.get(edge.fromState!)![0]!, bySignature.get(edge.toState!)![0]!, edge),
    );
  }

  const hiddenLinks = findHiddenLinks(order);
  const edges: Edge[] = [];

  for (const pair of order) {
    if (hiddenLinks.has(pair)) continue;
    const [source, target] = splitPair(pair);
    edges.push({
      id: pair,
      source,
      target,
      label: captionByPair.get(pair)!,
      type: 'default',
      animated: false,
      markerEnd: {
        type: 'arrowclosed',
        width: 18,
        height: 18,
        color: '#7d8698',
        // Without this the marker scales by strokeWidth and drifts off the line end.
        markerUnits: 'userSpaceOnUse',
        strokeWidth: 1,
      } as Edge['markerEnd'],
      style: { stroke: '#7d8698', strokeWidth: 1.5 },
      labelStyle: { fill: '#c8cfdb', fontSize: 11 },
      labelBgStyle: { fill: '#161a22' },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 3,
    });
  }

  const size = FRAME_SIZE[frame];
  const nodes: Node[] = [...bySignature.entries()].map(([signature, variants]) => {
    const active = variants[0]!;
    const screen = screenOf(document, active);
    const data: ScreenNodeData = {
      signature,
      title: titleOf(signature),
      eyebrow: eyebrowOf(screen, active.route),
      frame,
      variants,
      active,
      inbound: inbound.get(signature) ?? 0,
      outbound: outbound.get(signature) ?? 0,
    };
    return {
      id: signature,
      type: 'screen',
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data,
    };
  });

  return { nodes, edges, hiddenLinks: hiddenLinks.size };
}

function splitPair(pair: string): [string, string] {
  const at = pair.indexOf('->');
  return [pair.slice(0, at), pair.slice(at + 2)];
}

export function findHiddenLinks(pairs: readonly string[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  const nodes: string[] = [];
  const seenNode = new Set<string>();
  const hasIncoming = new Set<string>();

  for (const pair of pairs) {
    const [source, target] = splitPair(pair);
    outgoing.set(source, [...(outgoing.get(source) ?? []), pair]);
    hasIncoming.add(target);
    for (const node of [source, target]) {
      if (seenNode.has(node)) continue;
      seenNode.add(node);
      nodes.push(node);
    }
  }

  const kept = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];
  const enqueue = (node: string): void => {
    if (visited.has(node)) return;
    visited.add(node);
    queue.push(node);
  };

  for (const node of nodes) {
    if (!hasIncoming.has(node)) enqueue(node);
  }

  let head = 0;
  for (;;) {
    while (head < queue.length) {
      const node = queue[head++]!;
      for (const pair of outgoing.get(node) ?? []) {
        const [, target] = splitPair(pair);
        if (visited.has(target)) continue;
        enqueue(target);
        kept.add(pair);
      }
    }
    // A cycle with no way in, or a separate island, still needs a starting point.
    const orphan = nodes.find((node) => !visited.has(node));
    if (orphan === undefined) break;
    enqueue(orphan);
  }

  return new Set(pairs.filter((pair) => !kept.has(pair)));
}
