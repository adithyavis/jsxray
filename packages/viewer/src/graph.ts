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
  personaId: string;
  title: string;
  eyebrow: string | null;
  frame: FrameKind;
  state: ScreenState;
  inbound: number;
  outbound: number;
}

export interface LaneNodeFields {
  personaId: string;
  screens: number;
}

export type ScreenNodeData = ScreenNodeFields & Record<string, unknown>;
export type LaneNodeData = LaneNodeFields & Record<string, unknown>;

export interface GraphInput {
  document: JsxrayDocument;
  personaId: string | null;
  frame: FrameKind;
}

/**
 * §14 — one persona, one lane. A screen two personas both reached is two states
 * with two captures, and stacking them under one node hides the very difference
 * the persona axis exists to show.
 */
export interface GraphLane {
  personaId: string;
  nodes: Node[];
  edges: Edge[];
}

export interface Graph {
  lanes: GraphLane[];
  /** Every lane's edges, flattened — what React Flow is handed. */
  edges: Edge[];
  /** Traversals that are real but not drawn (see findHiddenLinks). */
  hiddenLinks: number;
}

/** Node ids are lane-scoped, because personas share screen signatures. */
export function nodeId(personaId: string, signature: string): string {
  return `${personaId}::${signature}`;
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

  const lanes: GraphLane[] = [];
  let hiddenLinks = 0;

  for (const id of personaOrder(document)) {
    if (personaId && id !== personaId) continue;
    const built = buildLane(document, id, frame);
    if (!built.lane.nodes.length) continue;
    lanes.push(built.lane);
    hiddenLinks += built.hiddenLinks;
  }

  return { lanes, edges: lanes.flatMap((lane) => lane.edges), hiddenLinks };
}

/** Config order first; a persona that only the states know about still gets a lane. */
function personaOrder(document: JsxrayDocument): string[] {
  const ids = document.personas.map((persona) => persona.id);
  for (const state of document.states) {
    if (!ids.includes(state.personaId)) ids.push(state.personaId);
  }
  return ids;
}

function buildLane(
  document: JsxrayDocument,
  personaId: string,
  frame: FrameKind,
): { lane: GraphLane; hiddenLinks: number } {
  // The crawl records one state per signature per persona (§7.6), so first wins.
  const bySignature = new Map<string, ScreenState>();
  for (const state of document.states) {
    if (state.personaId !== personaId) continue;
    if (!bySignature.has(state.signature)) bySignature.set(state.signature, state);
  }

  const runtimeEdges = document.edges.filter(
    (edge) =>
      edge.discoveredBy === 'runtime' &&
      edge.personaId === personaId &&
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
      transitionOf(bySignature.get(edge.fromState!)!, bySignature.get(edge.toState!)!, edge),
    );
  }

  const hidden = findHiddenLinks(order);
  const edges: Edge[] = [];

  for (const pair of order) {
    if (hidden.has(pair)) continue;
    const [source, target] = splitPair(pair);
    edges.push({
      id: `${personaId}::${pair}`,
      source: nodeId(personaId, source),
      target: nodeId(personaId, target),
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
  const nodes: Node[] = [...bySignature.entries()].map(([signature, state]) => {
    const screen = screenOf(document, state);
    const data: ScreenNodeData = {
      signature,
      personaId,
      title: titleOf(signature),
      eyebrow: eyebrowOf(screen, state.route),
      frame,
      state,
      inbound: inbound.get(signature) ?? 0,
      outbound: outbound.get(signature) ?? 0,
    };
    return {
      id: nodeId(personaId, signature),
      type: 'screen',
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data,
    };
  });

  return { lane: { personaId, nodes, edges }, hiddenLinks: hidden.size };
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
