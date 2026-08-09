import type { ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FRAME_SIZE, type ScreenNodeData } from './graph.js';

export function ScreenNode({ data, selected }: NodeProps): ReactElement {
  const node = data as ScreenNodeData;
  const size = FRAME_SIZE[node.frame];
  const capture = node.active.capture;

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
            <div className="frame-empty">
              {node.active.captureSkipped === 'privacy'
                ? 'not captured — privacy rule'
                : node.active.captureSkipped === 'failed'
                  ? 'capture failed'
                  : 'the crawl has not run'}
            </div>
          )}
        </div>
      </div>

      <div className="node-title">{node.title}</div>
      <div className="node-caption">
        {node.inbound} in · {node.outbound} out · {node.active.personaId}
        {node.variants.length > 1 ? ` +${node.variants.length - 1}` : ''}
      </div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
