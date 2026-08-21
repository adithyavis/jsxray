import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { JsxrayDocument, ScreenState, ViewportName } from '@jsxray/core';
import { hasRun, loadDocument } from './document.js';
import { buildGraph, viewportsOf, type ScreenNodeData } from './graph.js';
import { flowsOf, type Flow } from './flows.js';
import { layoutLanes } from './layout.js';
import { Inspector } from './Inspector.js';
import { LaneNode } from './LaneNode.js';
import { NonPageList } from './NonPageList.js';
import { ScreenNode } from './ScreenNode.js';

const NODE_TYPES = { screen: ScreenNode, lane: LaneNode };

/**
 * Below this zoom a node's own words are smaller than the dot grid, so they read
 * as noise on top of the picture rather than as a label for it. The frames stay.
 */
const LOD_FAR = 0.45;

const VIEWPORT_LABEL: Record<ViewportName, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
};

export function App(): ReactElement {
  const [document, setDocument] = useState<JsxrayDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDocument()
      .then(setDocument)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  if (error) {
    return (
      <Shell>
        <Notice tone="bad" title="Could not read the run">
          {error}
        </Notice>
      </Shell>
    );
  }
  if (!document) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }
  return <Workbench document={document} />;
}

/** The frame the app is always in: a brand cell, a top bar, and a body. */
function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">jsxray</div>
      </header>
      <div className="body-no-columns">
        <main className="canvas">{children}</main>
      </div>
    </div>
  );
}

interface Selection {
  id: string;
  data: ScreenNodeData;
}

function Workbench({ document }: { document: JsxrayDocument }): ReactElement {
  const crawled = hasRun(document, 'crawl');
  const [personaId, setPersonaId] = useState<string | null>(null);
  // §7.8 — the toggle offers the viewports this run photographed, and starts at the first.
  const viewports = useMemo(() => viewportsOf(document), [document]);
  const [viewport, setViewport] = useState<ViewportName>(() => viewports[0]!);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [showNonPages, setShowNonPages] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const graph = useMemo(
    () => buildGraph({ document, personaId, viewport }),
    [document, personaId, viewport],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const { setCenter, fitView, getZoom } = useReactFlow();

  // A new persona or a new viewport is a new map, so it is framed like one.
  useEffect(() => {
    let live = true;
    setEdges(graph.edges);
    layoutLanes(graph.lanes).then((laid) => {
      if (!live) return;
      setNodes(laid);
      requestAnimationFrame(() => {
        void fitView({ padding: 0.14, duration: 320 });
      });
    });
    return () => {
      live = false;
    };
  }, [graph, setEdges, setNodes, fitView]);

  // A rebuilt graph is a different set of nodes, so a selection or a flow held
  // over from the last one points at nothing.
  useEffect(() => {
    setSelected(null);
    setFlowId(null);
    setMatchIndex(0);
  }, [graph]);

  const nonPages = useMemo(() => document.screens.filter((screen) => !screen.isPage), [document]);
  const flows = useMemo(() => flowsOf(nodes), [nodes]);

  /** Screen nodes whose title, route, or flow answers what was typed. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return nodes
      .filter((node) => node.type === 'screen' && haystack(node).includes(needle))
      .map((node) => node.id);
  }, [nodes, query]);

  const flow = flows.find((candidate) => candidate.id === flowId) ?? null;

  /** What the reader has narrowed the canvas to — null when that is everything. */
  const scope = useMemo(() => {
    if (!flow && !matches) return null;
    const held = matches ? new Set(matches) : null;
    const ids = flow ? flow.nodeIds.filter((id) => !held || held.has(id)) : matches!;
    // A filter that empties the open flow is a question about the whole canvas,
    // not an answer of nothing: dimming every node at once reads as a fault.
    if (!ids.length && matches?.length) return new Set(matches);
    return new Set(ids);
  }, [flow, matches]);

  /**
   * §14 — one line in per screen, so the drawn lines are a spanning tree and
   * there is exactly one way from a seed to any node. That way in is the whole
   * answer to "how does the reader get here", so the trail back to the root is
   * lit, not only the screen one step before. The screens one step on are lit
   * too, because they are where this one leads.
   */
  const focus = useMemo(() => {
    if (!selected) return null;

    const wayIn = new Map<string, Edge>();
    const onward: Edge[] = [];
    for (const edge of graph.edges) {
      if (!wayIn.has(edge.target)) wayIn.set(edge.target, edge);
      if (edge.source === selected.id) onward.push(edge);
    }

    const trailNodes = new Set<string>();
    const trailEdges = new Set<string>();
    const seen = new Set<string>([selected.id]);
    let at = selected.id;
    for (;;) {
      const edge = wayIn.get(at);
      // A root has no line into it, and a graph that is not a tree could send
      // the walk round in a circle.
      if (!edge || seen.has(edge.source)) break;
      seen.add(edge.source);
      trailNodes.add(edge.source);
      trailEdges.add(edge.id);
      at = edge.source;
    }

    const nodeIds = new Set<string>([selected.id, ...trailNodes]);
    const edgeIds = new Set<string>(trailEdges);
    for (const edge of onward) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.target);
    }
    return { nodeIds, edgeIds, trailNodes, trailEdges };
  }, [selected, graph.edges]);

  /**
   * `closer` is for a jump the reader did not aim with the mouse — a filter hit,
   * or a link followed out of the inspector — where landing at whatever zoom the
   * canvas happened to be at would arrive on an unreadable node.
   */
  const select = useCallback(
    (id: string, closer = false) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node || node.type !== 'screen') return;
      setSelected({ id, data: node.data as ScreenNodeData });
      setShowNonPages(false);
      const width = node.width ?? 300;
      const height = node.height ?? 232;
      void setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: closer ? Math.max(getZoom(), 0.8) : getZoom(),
        duration: 380,
      });
    },
    [nodes, setCenter, getZoom],
  );

  /**
   * An overlay state folds onto the screen it is drawn over (§14), so the
   * signature the inspector lists is not always a node of its own.
   */
  const selectSignature = useCallback(
    (persona: string, signature: string) => {
      const exact = `${persona}::${signature}`;
      if (nodes.some((node) => node.id === exact)) return select(exact, true);
      const folded = `${persona}::${signature.split('$')[0]}`;
      if (nodes.some((node) => node.id === folded)) return select(folded, true);
    },
    [nodes, select],
  );

  const step = useCallback(
    (delta: number) => {
      if (!matches?.length) return;
      const next = (matchIndex + delta + matches.length) % matches.length;
      setMatchIndex(next);
      select(matches[next]!, true);
    },
    [matches, matchIndex, select],
  );

  const pickFlow = useCallback(
    (next: Flow | null) => {
      setFlowId(next?.id ?? null);
      setShowNonPages(false);
      if (!next) return void fitView({ padding: 0.14, duration: 380 });
      void fitView({
        nodes: next.nodeIds.map((id) => ({ id })),
        padding: 0.22,
        duration: 380,
        maxZoom: 1,
      });
    },
    [fitView],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (event.key === 'Escape') {
        if (typing) target.blur();
        setSelected(null);
        setShowNonPages(false);
        return;
      }
      if (typing) return;
      if (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key === 'k')) {
        event.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (event.key === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        void fitView({ duration: 420, padding: 0.14 });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitView]);

  // Dimming is presentation over the laid-out nodes, so the graph itself and the
  // positions React Flow manages stay untouched.
  const viewNodes = useMemo(
    () =>
      nodes.map((node) => {
        if (node.type !== 'screen') return node;
        const marks: string[] = [];
        // The way in to the selected screen is the answer being given, so it
        // stays lit even where the open flow would otherwise drop it back.
        if (node.id === selected?.id) marks.push('is-selected');
        else if (focus?.trailNodes.has(node.id)) marks.push('is-trail');
        else if (scope) marks.push(scope.has(node.id) ? 'is-match' : 'is-dim');
        else if (focus) marks.push(focus.nodeIds.has(node.id) ? 'is-near' : 'is-dim');
        return marks.length ? { ...node, className: marks.join(' ') } : node;
      }),
    [nodes, scope, focus, selected],
  );

  const viewEdges = useMemo(() => {
    // A selection is a question about lines, so it decides them; a flow only
    // has a say while nothing is selected.
    if (focus) {
      return edges.map((edge) => {
        if (focus.trailEdges.has(edge.id)) return lit(edge, 'in');
        if (focus.edgeIds.has(edge.id)) return lit(edge, 'on');
        return { ...edge, className: 'is-dim' };
      });
    }
    if (scope) {
      return edges.map((edge) =>
        scope.has(edge.source) && scope.has(edge.target)
          ? edge
          : { ...edge, className: 'is-dim' },
      );
    }
    return edges;
  }, [edges, scope, focus]);

  const personas = personaOptions(document);
  // Nothing selected is nothing to inspect, so the column is not there at all.
  const inspecting = showNonPages || Boolean(selected);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">jsxray</div>

        <Segmented
          label="Persona"
          value={personaId ?? ''}
          disabled={!crawled}
          options={[{ value: '', label: 'All' }, ...personas]}
          onChange={(value) => setPersonaId(value || null)}
        />

        <Segmented
          label="Viewport"
          value={viewport}
          options={viewports.map((name) => ({ value: name, label: VIEWPORT_LABEL[name] }))}
          onChange={(value) => setViewport(value as ViewportName)}
        />

        <span className="topbar-spacer" />
        {/* <Coverage document={document} hiddenLinks={graph.hiddenLinks} /> */}
      </header>

      <div className={`body${inspecting ? '' : ' body-bare'}`}>
        <nav className="sidebar" aria-label="Screens">
          <div className="filter">
            <SearchIcon />
            <input
              ref={filterRef}
              type="text"
              value={query}
              spellCheck={false}
              placeholder="Filter screens…"
              aria-label="Filter screens by name or route"
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }}
            />
            {query ? (
              <button
                type="button"
                className="filter-clear"
                aria-label="Clear the filter"
                onClick={() => setQuery('')}
              >
                ×
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </div>

          {matches ? (
            <p className="filter-result">
              {matches.length
                ? `${matches.length} screen${matches.length === 1 ? '' : 's'} · ${matchIndex + 1} of ${matches.length}`
                : 'No screen matches'}
            </p>
          ) : null}

          <h2 className="side-head">Flows</h2>
          <ul className="flow-list">
            {flows.map((candidate) => {
              const shown = matches
                ? candidate.nodeIds.filter((id) => matches.includes(id)).length
                : candidate.nodeIds.length;
              return (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className={`flow${candidate.id === flowId ? ' flow-on' : ''}${
                      matches && !shown ? ' flow-empty' : ''
                    }`}
                    aria-pressed={candidate.id === flowId}
                    onClick={() => pickFlow(candidate.id === flowId ? null : candidate)}
                  >
                    <span className="flow-name">{candidate.label}</span>
                    <span className="flow-count">{shown}</span>
                  </button>

                  {/* A flow's screens sit far apart on the tree, so fitting to one
                      often lands below the zoom where names are readable. The list
                      names them, and picking one arrives close enough to read. */}
                  {candidate.id === flowId ? (
                    <ul className="flow-screens">
                      {candidate.nodeIds
                        .filter((id) => !matches || matches.includes(id))
                        .map((id) => {
                          const held = nodes.find((node) => node.id === id);
                          if (!held) return null;
                          const data = held.data as ScreenNodeData;
                          return (
                            <li key={id}>
                              <button
                                type="button"
                                className={`flow-screen${id === selected?.id ? ' flow-screen-on' : ''}`}
                                title={data.state.route}
                                onClick={() => select(id, true)}
                              >
                                {data.title}
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {nonPages.length ? (
            <>
              <h2 className="side-head">Not on the canvas</h2>
              <ul className="flow-list">
                <li>
                  <button
                    type="button"
                    className={`flow${showNonPages ? ' flow-on' : ''}`}
                    aria-pressed={showNonPages}
                    onClick={() => {
                      setShowNonPages((value) => !value);
                      setSelected(null);
                    }}
                  >
                    <span className="flow-name">Non-page screens</span>
                    <span className="flow-count">{nonPages.length}</span>
                  </button>
                </li>
              </ul>
            </>
          ) : null}
        </nav>

        <main className="canvas">
          {nodes.length ? (
            <ReactFlow
              nodes={viewNodes}
              edges={viewEdges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_event, node) => {
                if (node.type === 'screen') select(node.id);
              }}
              onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
              fitView
              fitViewOptions={{ padding: 0.14 }}
              minZoom={0.1}
              maxZoom={2}
            >
              <ZoomBar />
            </ReactFlow>
          ) : graph.lanes.length ? (
            // The layout is async, so `nodes` is empty until elk answers. Without
            // this the empty-crawl notice flashes on load and says the run found
            // nothing, which is a different claim.
            <Spinner />
          ) : (
            <Notice tone="wait" title={crawled ? 'No states on the canvas' : 'The crawl has not run'}>
              {crawled
                ? 'The crawl reached no states for this persona.'
                : 'There are no captures and no confirmed transitions yet.'}
            </Notice>
          )}
        </main>

        {inspecting ? (
          <aside className="inspector">
            {showNonPages ? (
              <NonPageList screens={nonPages} onClose={() => setShowNonPages(false)} />
            ) : (
              <Inspector
                document={document}
                node={selected!.data}
                onSelect={selectSignature}
                onClose={() => setSelected(null)}
              />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** §14 — config order first; a persona only the states know about still counts. */
function personaOptions(document: JsxrayDocument): { value: string; label: string }[] {
  const ids = document.personas.map((persona) => persona.id);
  for (const state of document.states) {
    if (!ids.includes(state.personaId)) ids.push(state.personaId);
  }
  return ids.map((id) => ({ value: id, label: label(id) }));
}

function label(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function Segmented({
  label: name,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange(value: string): void;
}): ReactElement {
  return (
    <div className="segmented" role="group" aria-label={name}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`seg${option.value === value ? ' seg-on' : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The zoom readout and the level-of-detail class both follow the same number,
 * so they are read in one place. This renders inside React Flow, where the
 * store is, and nothing above it re-renders as the canvas moves.
 */
function ZoomBar(): ReactElement {
  const zoom = useStore((state) => state.transform[2]);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  useEffect(() => {
    window.document.querySelector('.canvas')?.classList.toggle('lod-far', zoom < LOD_FAR);
  }, [zoom]);

  return (
    <div className="zoombar">
      <button type="button" onClick={() => void zoomOut({ duration: 160 })} aria-label="Zoom out">
        −
      </button>
      <span className="zoombar-value">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => void zoomIn({ duration: 160 })} aria-label="Zoom in">
        +
      </button>
      <span className="zoombar-split" />
      <button type="button" onClick={() => void fitView({ padding: 0.14, duration: 380 })}>
        Fit
      </button>
    </div>
  );
}

/**
 * How the reader got here and where they can go next are two different answers,
 * so they are two different colours. Both march their dashes source-to-target,
 * which is the direction the crawl travelled in either case.
 *
 * The colour is set on the edge rather than in the stylesheet because the
 * arrowhead is a marker, not part of the path, and takes its colour from the
 * same place. These two must match `--way-in` and `--way-on`.
 */
const LIT: Record<'in' | 'on', string> = { in: '#5b9dfc', on: '#3fbf9a' };

function lit(edge: Edge, way: 'in' | 'on'): Edge {
  const colour = LIT[way];
  return {
    ...edge,
    animated: true,
    className: `is-lit is-way-${way}`,
    zIndex: way === 'in' ? 2 : 1,
    style: { ...edge.style, stroke: colour, strokeWidth: 2 },
    markerEnd: {
      ...(edge.markerEnd as Record<string, unknown>),
      color: colour,
    } as Edge['markerEnd'],
  };
}

function haystack(node: Node): string {
  const data = node.data as ScreenNodeData;
  return `${data.title} ${data.section ?? ''} ${data.state.route} ${data.signature}`.toLowerCase();
}

function Coverage({
  document,
  hiddenLinks,
}: {
  document: JsxrayDocument;
  hiddenLinks: number;
}): ReactElement | null {
  const coverage = document.coverage?.overall;
  if (!coverage) return null;

  return (
    <div className="stats">
      <Stat
        label="screens"
        value={coverage.screensReached}
        of={coverage.screensDeclared ?? null}
        title="States the crawl reached, against the screens static analysis declared."
      />
      <Stat
        label="edges"
        value={coverage.edgesConfirmed}
        of={coverage.edgesMatchable}
        title="Declared links the crawl confirmed by traversing them."
      />
      {hiddenLinks ? (
        <span
          className="tally"
          title="Only the shortest way into each screen is drawn. Every other traversal stays in the document and in the inspector."
        >
          <b>{hiddenLinks}</b> not drawn
        </span>
      ) : null}
      {coverage.edgesUnmatchable ? (
        <span
          className="tally tally-warn"
          title="Runtime traversals that match no declared link — the crawl found more than the source said."
        >
          <b>{coverage.edgesUnmatchable}</b> unmatchable
        </span>
      ) : null}
    </div>
  );
}

function Stat({
  label: name,
  value,
  of,
  title,
}: {
  label: string;
  value: number;
  of: number | null;
  title: string;
}): ReactElement {
  const share = of ? Math.min(1, value / of) : 0;
  return (
    <span className="stat" title={title}>
      <span className="stat-value">
        <b>{value}</b>
        <span className="stat-of">/{of ?? '—'}</span>
      </span>
      <span className="stat-label">{name}</span>
      <span className="meter" aria-hidden>
        <i style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </span>
  );
}

/**
 * The faint ring is the whole shape; the bright arc is the part that turns. Under
 * `prefers-reduced-motion` the arc stops and the ring still reads as deliberate.
 */
function Spinner(): ReactElement {
  return (
    <div className="spinner" role="status">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden focusable="false">
        <circle className="spinner-track" cx="16" cy="16" r="13" />
        <circle className="spinner-arc" cx="16" cy="16" r="13" />
      </svg>
      <span className="sr-only">Reading the run</span>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: 'wait' | 'bad';
  title: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className={`notice notice-${tone}`}>
      <div className="notice-card">
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
    </div>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Root(): ReactElement {
  return (
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  );
}
