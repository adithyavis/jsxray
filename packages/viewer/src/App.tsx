import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import { hasRun, loadDocument } from './document.js';
import { buildGraph, frameForCaptures, type FrameKind, type ScreenNodeData } from './graph.js';
import { layoutLanes } from './layout.js';
import { Inspector } from './Inspector.js';
import { LaneNode } from './LaneNode.js';
import { NonPageList } from './NonPageList.js';
import { ScreenNode } from './ScreenNode.js';

const NODE_TYPES = { screen: ScreenNode, lane: LaneNode };

export function App(): ReactElement {
  const [document, setDocument] = useState<JsxrayDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDocument()
      .then(setDocument)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  if (error) return <Shell><div className="notice">{error}</div></Shell>;
  if (!document) return <Shell><div className="notice">reading jsxray.json…</div></Shell>;
  return <Canvas document={document} />;
}

function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="app">
      <div className="rail">
        <span className="rail-brand">jsxray</span>
      </div>
      <main className="stage">{children}</main>
    </div>
  );
}

function Canvas({ document }: { document: JsxrayDocument }): ReactElement {
  const crawled = hasRun(document, 'crawl');
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [frame, setFrame] = useState<FrameKind>(() => frameForCaptures(document));
  const [selected, setSelected] = useState<ScreenState | null>(null);
  const [showNonPages, setShowNonPages] = useState(false);

  const graph = useMemo(
    () => buildGraph({ document, personaId, frame }),
    [document, personaId, frame],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    let live = true;
    setEdges(graph.edges);
    layoutLanes(graph.lanes).then((laid) => {
      if (live) setNodes(laid);
    });
    return () => {
      live = false;
    };
  }, [graph, setEdges, setNodes]);

  const nonPages = document.screens.filter((screen) => !screen.isPage);

  return (
    <div className="app">
      <div className="rail">
        <span className="rail-brand">jsxray</span>
      </div>

      <main className="stage">
        <header className="toolbar">
          <label>
            Persona
            <select
              value={personaId ?? ''}
              disabled={!crawled}
              onChange={(event) => setPersonaId(event.target.value || null)}
            >
              <option value="">all</option>
              {document.personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.id}
                </option>
              ))}
            </select>
          </label>

          <label>
            Frame
            <select value={frame} onChange={(event) => setFrame(event.target.value as FrameKind)}>
              <option value="browser">browser</option>
              <option value="phone">phone</option>
            </select>
          </label>

          <button type="button" onClick={() => setShowNonPages((value) => !value)}>
            Non-page screens ({nonPages.length})
          </button>

          <span className="toolbar-spacer" />
          {graph.hiddenLinks ? (
            <span className="muted">{graph.hiddenLinks} other links not drawn</span>
          ) : null}
          <Coverage document={document} />
        </header>

        <div className="canvas">
          {nodes.length ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_event, node) => {
                if (node.type === 'screen') setSelected((node.data as ScreenNodeData).state);
              }}
              onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
              fitView
              minZoom={0.1}
              maxZoom={2}
            >
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="notice">
              {crawled
                ? 'The crawl reached no states.'
                : 'The crawl has not run — no captures and no confirmed transitions yet.'}
            </div>
          )}
        </div>
      </main>

      {selected ? (
        <Inspector document={document} state={selected} onClose={() => setSelected(null)} />
      ) : null}

      {showNonPages ? (
        <NonPageList screens={nonPages} onClose={() => setShowNonPages(false)} />
      ) : null}
    </div>
  );
}

function Coverage({ document }: { document: JsxrayDocument }): ReactElement {
  const coverage = document.coverage?.overall;
  if (!coverage) return <span className="muted">no coverage</span>;
  return (
    <span className="coverage">
      screens {coverage.screensReached}/{coverage.screensDeclared ?? '—'} · edges{' '}
      {coverage.edgesConfirmed}/{coverage.edgesMatchable}
      {coverage.edgesUnmatchable ? ` · ${coverage.edgesUnmatchable} unmatchable` : ''}
    </span>
  );
}

export function Root(): ReactElement {
  return (
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  );
}
