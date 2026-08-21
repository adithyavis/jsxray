import type { ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { captureAt, FRAME_SIZE, type ScreenNodeData } from './graph.js';

/** §7.8 — what the frame says when it has no picture to show. */
const EMPTY_REASON: Record<string, string> = {
  privacy: 'not captured — privacy rule',
  failed: 'capture failed',
  blank: 'rendered nothing',
  'not-run': 'the crawl has not run',
};

export function ScreenNode({ data, selected }: NodeProps): ReactElement {
  const node = data as ScreenNodeData;
  const size = FRAME_SIZE[node.viewport];
  const capture = captureAt(node.state, node.viewport);
  const loading = node.state.captureStatus === 'loading';
  // §7.8 — a state photographed at the other viewport only says that, rather than
  // borrowing the reason the states with no picture at all have.
  const empty = node.state.captures.length
    ? `not captured at ${node.viewport}`
    : (EMPTY_REASON[node.state.captureStatus] ?? 'no capture');

  return (
    <div className="node" style={{ width: size.width }} title={node.state.route}>
      <div className="node-eyebrow">{node.eyebrow ?? ' '}</div>

      <div
        className={`frame frame-${node.viewport}${selected ? ' frame-selected' : ''}`}
        style={{ height: size.height - 52 }}
      >
        <div className="frame-chrome">
          <span />
          <span />
          <span />
        </div>
        <div className="frame-screen">
          {capture ? (
            <img src={capture.path} alt={node.title} draggable={false} loading="lazy" />
          ) : (
            <div className="frame-empty">{empty}</div>
          )}
        </div>
      </div>

      <div className="node-title">{node.title}</div>
      <div className="node-caption">
        <span className="degree" title={degreeHint(node.inbound, node.inboundDrawn, 'in')}>
          <Arrow direction="in" />
          {node.inbound}
        </span>
        <span className="degree" title={degreeHint(node.outbound, node.outboundDrawn, 'out')}>
          <Arrow direction="out" />
          {node.outbound}
        </span>
        <span className="node-persona">{node.personaId}</span>
        {/* §7.10 — a skeleton that is captured says so, rather than posing as the screen. */}
        {loading ? <span className="node-flag">still loading</span> : null}
      </div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** The caption keeps the true count (§14), so the hint says how many are lines. */
function degreeHint(total: number, drawn: number, direction: 'in' | 'out'): string {
  const head = `${total} confirmed transitions ${direction}`;
  return drawn === total ? head : `${head} — ${drawn} drawn, ${total - drawn} not`;
}

function Arrow({ direction }: { direction: 'in' | 'out' }): ReactElement {
  return (
    <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden focusable="false">
      <path
        d={
          direction === 'in'
            ? 'M0.5 5h5.5M3.5 2.5 6 5 3.5 7.5M9 1.5v7'
            : 'M1 1.5v7M3.5 5H9M6.5 2.5 9 5 6.5 7.5'
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
