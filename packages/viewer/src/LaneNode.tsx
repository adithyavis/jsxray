import type { ReactElement } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { LaneNodeData } from './graph.js';

export function LaneNode({ data }: NodeProps): ReactElement {
  const lane = data as LaneNodeData;
  return (
    <div className="lane">
      <span className="lane-persona">{lane.personaId}</span>
      <span className="lane-count">{lane.screens} screens</span>
    </div>
  );
}
