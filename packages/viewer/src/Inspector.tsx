import type { ReactElement } from 'react';
import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import { screenOf, titleOf } from './document.js';

interface InspectorProps {
  document: JsxrayDocument;
  state: ScreenState;
  onClose(): void;
}

export function Inspector({ document, state, onClose }: InspectorProps): ReactElement {
  const screen = screenOf(document, state);
  const outgoing = document.edges.filter(
    (edge) => edge.discoveredBy === 'runtime' && edge.fromState === state.signature,
  );
  const personas = document.states
    .filter((candidate) => candidate.signature === state.signature)
    .map((candidate) => candidate.personaId);

  return (
    <aside className="inspector">
      <header>
        <div>
          <h2>{titleOf(state.signature)}</h2>
          <code>{state.signature}</code>
        </div>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </header>

      <section>
        <h3>Route</h3>
        <dl>
          <dt>canonical</dt>
          <dd>{state.route}</dd>
          <dt>observed</dt>
          <dd>{state.url}</dd>
          {screen ? (
            <>
              <dt>pattern</dt>
              <dd>{screen.pattern}</dd>
              <dt>file</dt>
              <dd>{screen.file ?? '—'}</dd>
              <dt>component</dt>
              <dd>{screen.componentId ?? '—'}</dd>
              {screen.meta.groups.length ? (
                <>
                  <dt>groups</dt>
                  <dd>{screen.meta.groups.join(', ')}</dd>
                </>
              ) : null}
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
          <ul>
            {state.overlays.map((overlay) => (
              <li key={overlay.name}>
                {overlay.name} <span className="muted">{overlay.role} · {overlay.via}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Reached by</h3>
        {state.reachedVia.length ? (
          <ol className="steps">
            {state.reachedVia.map((step, index) => (
              <li key={`${step.kind}-${index}`}>
                <span className="step-kind">{step.kind}</span>
                <code>{step.label ?? step.target}</code>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">seeded directly by URL</p>
        )}
      </section>

      <section>
        <h3>Confirmed transitions out ({outgoing.length})</h3>
        {outgoing.length ? (
          <ul>
            {outgoing.map((edge) => (
              <li key={edge.id}>
                <span className="step-kind">{edge.label ?? edge.kind}</span>
                <code>{edge.toState}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">none traversed</p>
        )}
      </section>

      {state.deadActions.length ? (
        <section>
          <h3>Dead actions ({state.deadActions.length})</h3>
          <ul>
            {state.deadActions.map((action) => (
              <li key={`${action.label}-${action.target}`}>{action.label ?? action.target}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Personas</h3>
        <p>{[...new Set(personas)].join(', ')}</p>
      </section>

      <section className="pending">
        <h3>Component tree</h3>
        <p className="muted">Arrives with the v2 component graph — this stage has not run.</p>
      </section>
    </aside>
  );
}
