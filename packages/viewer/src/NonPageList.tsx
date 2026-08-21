import type { ReactElement } from 'react';
import type { Screen } from '@jsxray/core';

interface NonPageListProps {
  screens: Screen[];
  onClose(): void;
}

/** §14 — they render no UI and are never crawled, so they are not nodes. */
export function NonPageList({ screens, onClose }: NonPageListProps): ReactElement {
  return (
    <div className="panel">
      <header className="panel-head">
        <p className="eyebrow">Not on the canvas</p>
        <div className="panel-title">
          <h2>Non-page screens</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close the list">
            ×
          </button>
        </div>
        <code className="route">{screens.length} declared</code>
      </header>

      <div className="panel-body">
        <p className="muted note">
          Route handlers and error states render no UI, so they have no capture and do not belong on
          the flow canvas.
        </p>
        <ul className="rows">
          {screens.map((screen) => (
            <li key={screen.id} className="row row-stack">
              <span className="row-main">
                <code>{screen.id}</code> <code className="row-kind">{screen.kind}</code>
              </span>
              {screen.file ? <span className="row-note wrap-any">{screen.file}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
