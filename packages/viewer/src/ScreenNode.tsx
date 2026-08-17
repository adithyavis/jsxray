import type { ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FRAME_SIZE, type ScreenNodeData } from './graph.js';

/** §7.8 — what the frame says when it has no picture to show. */
const EMPTY_REASON: Record<string, string> = {
  privacy: 'not captured — privacy rule',
  failed: 'capture failed',
  blank: 'rendered nothing',
  'not-run': 'the crawl has not run',
};

export function ScreenNode({ data, selected }: NodeProps): ReactElement {
  const node = data as ScreenNodeData;
  const size = FRAME_SIZE[node.frame];
  const capture = node.state.capture;

  return (
    <div className="node" style={{ width: size.width }}>
      {node.eyebrow ? <div className="node-eyebrow">{node.eyebrow}</div> : null}

      <div
        className={`frame frame-${node.frame}${selected ? ' frame-selected' : ''}`}
        style={{ height: size.height - 52 }}
      >
        <div className="frame-chrome">
          <span />
          <span />
          <span />
        </div>
        <div className="frame-screen">
          {capture ? (
            <img src={capture.path} alt={node.title} draggable={false} />
          ) : (
            <div className="frame-empty">{EMPTY_REASON[node.state.captureStatus] ?? 'no capture'}</div>
          )}
        </div>
      </div>

      <div className="node-title">{node.title}</div>
      <div className="node-caption">
        {node.inbound} in · {node.outbound} out · {node.personaId}
        {/* §7.10 — a skeleton that is captured says so, rather than posing as the screen. */}
        {node.state.captureStatus === 'loading' ? ' · still loading' : null}
      </div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
