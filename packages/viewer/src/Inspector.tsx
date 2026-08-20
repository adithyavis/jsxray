import type { ReactElement } from 'react';
import type { Edge, JsxrayDocument, ScreenState } from '@jsxray/core';
import type { ScreenNodeData } from './graph.js';
import { screenOf, titleOf } from './document.js';

interface InspectorProps {
  document: JsxrayDocument;
  node: ScreenNodeData;
  onSelect(personaId: string, signature: string): void;
  onClose(): void;
}

/** §7.8 — each status says a different thing about why there is no picture. */
const NO_CAPTURE: Record<string, string> = {
  privacy: 'Not captured — a privacy rule covers this screen.',
  failed: 'The capture failed.',
  blank: 'The screen rendered nothing.',
  'not-run': 'The crawl has not run.',
};

export function Inspector({ document, node, onSelect, onClose }: InspectorProps): ReactElement {
  const state = node.state;
  const screen = screenOf(document, state);

  // This is one persona's state, so only that persona's traversals belong here.
  const outgoing = document.edges.filter(
    (edge) =>
      edge.discoveredBy === 'runtime' &&
      edge.fromState === state.signature &&
      edge.personaId === state.personaId,
  );

  const params = screen?.meta.params ?? [];
  const component = document.components.find((record) => record.id === screen?.componentId);
  const props = component?.props ?? null;

  return (
    <div className="panel">
      <header className="panel-head">
        <p className="eyebrow">Selected screen</p>
        <div className="panel-title">
          <h2>{titleOf(state.signature)}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Clear the selection">
            ×
          </button>
        </div>
        <code className="route">{state.route}</code>
      </header>

      <div className="panel-body">
        {state.capture ? (
          <a className="shot" href={state.capture.path} target="_blank" rel="noreferrer">
            <img src={state.capture.path} alt={`Capture of ${titleOf(state.signature)}`} />
            <span className="shot-foot">
              {state.capture.viewport.width}×{state.capture.viewport.height} · open full size
            </span>
          </a>
        ) : (
          <div className="shot shot-none">
            <span className="shot-chip">{baseName(screen?.file) ?? 'no capture'}</span>
            <span className="shot-why">
              {NO_CAPTURE[state.captureStatus] ?? 'There is no capture for this state.'}
            </span>
          </div>
        )}

        <div className="cards">
          <div className="card">
            <span className="card-label">Inbound</span>
            <span className="card-value">{node.inbound}</span>
          </div>
          <div className="card">
            <span className="card-label">Outbound</span>
            <span className="card-value">{node.outbound}</span>
          </div>
        </div>

        <section>
          <h3>Outgoing links</h3>
          {outgoing.length ? (
            <ul className="links">
              {outgoing.map((edge) => (
                <li key={edge.id}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onSelect(state.personaId, edge.toState!)}
                    title={`Go to ${edge.toState}`}
                  >
                    <span className="link-arrow" aria-hidden>
                      →
                    </span>
                    <span className="link-name">{linkName(document, edge)}</span>
                    <code className="link-kind">{edge.kind}</code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing was traversed out of this screen.</p>
          )}
        </section>

        {props?.length ? (
          <section>
            <h3>Props observed</h3>
            <div className="chips">
              {props.map((prop) => (
                <code key={prop.name} className="chip">
                  {prop.name}
                </code>
              ))}
            </div>
          </section>
        ) : params.length ? (
          <section>
            <h3>Route params</h3>
            <div className="chips">
              {params.map((param) => (
                <code key={param} className="chip">
                  {param}
                </code>
              ))}
            </div>
          </section>
        ) : null}

        <Caveat document={document} state={state} />

        <section>
          <h3>Source</h3>
          <dl>
            <dt>observed</dt>
            <dd className="wrap-any">{state.url}</dd>
            {screen ? (
              <>
                <dt>pattern</dt>
                <dd>{screen.pattern}</dd>
                <dt>file</dt>
                <dd className="wrap-any">{screen.file ?? '—'}</dd>
                <dt>component</dt>
                <dd className="wrap-any">{screen.componentId ?? '—'}</dd>
              </>
            ) : (
              <>
                <dt>declared</dt>
                <dd>no — found only at runtime</dd>
              </>
            )}
          </dl>
        </section>

        {state.overlays.length ? (
          <section>
            <h3>Overlays</h3>
            <ul className="rows">
              {state.overlays.map((overlay) => (
                <li key={overlay.name} className="row">
                  <span className="row-main">{overlay.name}</span>
                  <span className="row-note">
                    {overlay.role} · {overlay.via}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <h3>Reached by</h3>
          {state.reachedVia.length ? (
            <ol className="rows">
              {state.reachedVia.map((step, index) => (
                <li key={`${step.kind}-${index}`} className="row">
                  <code className="row-kind">{step.kind}</code>
                  <span className="row-main">{step.label ?? step.target}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Seeded directly by URL.</p>
          )}
        </section>

        {state.deadActions.length ? (
          <section>
            <h3>
              Dead actions <span className="count">{state.deadActions.length}</span>
            </h3>
            <p className="muted note">Controls the crawl used that changed nothing observable.</p>
            <ul className="rows">
              {state.deadActions.map((action) => (
                <li key={`${action.label}-${action.target}`} className="row">
                  <span className="row-main">{action.label ?? action.target}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="pending">
          <h3>Component tree</h3>
          <p className="muted">Arrives with the v2 component graph — this stage has not run.</p>
        </section>
      </div>
    </div>
  );
}

/**
 * §14 — one honest caveat about this screen, most load-bearing first. A screen
 * only some personas reached is a fact about who can see it; a screen with
 * actions the crawl never used is a fact about how completely it was read.
 */
function Caveat({
  document,
  state,
}: {
  document: JsxrayDocument;
  state: ScreenState;
}): ReactElement | null {
  const reached = [
    ...new Set(
      document.states
        .filter((candidate) => candidate.signature === state.signature)
        .map((candidate) => candidate.personaId),
    ),
  ];

  if (document.personas.length > 1 && reached.length < document.personas.length) {
    const records = document.personas.filter((persona) => reached.includes(persona.id));
    const gate = records.every((persona) => persona.authenticated)
      ? 'Signed-in only'
      : records.every((persona) => !persona.authenticated)
        ? 'Signed-out only'
        : `Only reached as ${reached.join(', ')}`;
    return (
      <div className="caveat">
        <strong>{gate}</strong>
        <span>
          Reached by {reached.join(', ')} — the other personas in this run never landed here.
        </span>
      </div>
    );
  }

  if (state.untriedActions.length) {
    const reasons = new Map<string, number>();
    for (const action of state.untriedActions) {
      reasons.set(action.reason, (reasons.get(action.reason) ?? 0) + 1);
    }
    const worded = [...reasons]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    return (
      <div className="caveat">
        <strong>{state.untriedActions.length} actions not tried</strong>
        <span>{worded}. What is drawn out of this screen is not all of it.</span>
      </div>
    );
  }

  return null;
}

/** The line is named for where it goes, so the list is too (§14). */
function linkName(document: JsxrayDocument, edge: Edge): string {
  const target = document.states.find((state) => state.signature === edge.toState);
  return target ? titleOf(target.signature) : (edge.toState ?? edge.to ?? edge.kind);
}

function baseName(file: string | null | undefined): string | null {
  if (!file) return null;
  return file.split('/').pop() ?? file;
}
