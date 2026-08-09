import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import type { Edge, Node } from '@xyflow/react';
import { eyebrowOf, screenOf, titleOf } from './document.js';

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

export function buildGraph(input: GraphInput): { nodes: Node[]; edges: Edge[] } {
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
  const seenPairs = new Set<string>();
  const edges: Edge[] = [];

  for (const edge of runtimeEdges) {
    const pair = `${edge.fromState}->${edge.toState}`;
    outbound.set(edge.fromState!, (outbound.get(edge.fromState!) ?? 0) + 1);
    inbound.set(edge.toState!, (inbound.get(edge.toState!) ?? 0) + 1);
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    edges.push({
      id: pair,
      source: edge.fromState!,
      target: edge.toState!,
      label: edge.label ?? edge.kind,
      type: 'default',
      animated: false,
      markerEnd: { type: 'arrowclosed', width: 14, height: 14, color: '#7d8698' } as Edge['markerEnd'],
      style: { stroke: '#7d8698', strokeWidth: 1.25 },
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

  return { nodes, edges };
}
