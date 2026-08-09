import type { ReactElement } from 'react';
import type { Screen } from '@jsxray/core';

interface NonPageListProps {
  screens: Screen[];
  onClose(): void;
}

/** §14 — they render no UI and are never crawled, so they are not nodes. */
export function NonPageList({ screens, onClose }: NonPageListProps): ReactElement {
  return (
    <aside className="inspector">
      <header>
        <div>
          <h2>Non-page screens</h2>
          <code>{screens.length} declared</code>
        </div>
        <button type="button" onClick={onClose} aria-label="Close list">
          ×
        </button>
      </header>

      <section>
        <p className="muted">
          Route handlers and error states render no UI, so they have no capture and do not belong on
          the flow canvas.
        </p>
        {screens.length ? (
          <ul>
            {screens.map((screen) => (
              <li key={screen.id}>
                <code>{screen.id}</code>
                <span className="muted"> {screen.kind}</span>
                {screen.file ? <div className="muted">{screen.file}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">none</p>
        )}
      </section>
    </aside>
  );
}
