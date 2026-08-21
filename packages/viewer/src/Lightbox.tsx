import { useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { Capture } from '@jsxray/core';

interface LightboxProps {
  title: string;
  route: string;
  capture: Capture;
  onClose(): void;
}

/**
 * The inspector hides its overflow, so a modal drawn inside it would be clipped
 * to the third column. It is drawn on the body instead.
 */
export function Lightbox({ title, route, capture, onClose }: LightboxProps): ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      // The reader came from the shot in the inspector, so that is where they go back to.
      opener?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Capture of ${title}`}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="Close the capture"
      >
        ×
      </button>

      <figure className="lightbox-figure" onClick={(event) => event.stopPropagation()}>
        <img src={capture.path} alt={`Capture of ${title}`} />
        <figcaption className="lightbox-caption">
          <span className="lightbox-title">{title}</span>
          <code className="lightbox-route">{route}</code>
          <span className="lightbox-size">
            {capture.viewport.width}×{capture.viewport.height}
          </span>
          <a href={capture.path} target="_blank" rel="noreferrer">
            open the file
          </a>
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
