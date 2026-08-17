import { describe, expect, it } from 'vitest';
import { click, type ClickTarget, type Pointer } from '../src/renderer/playwright/index.js';

const VIEWPORT = { width: 1440, height: 900 };

/** Records where the pointer went, so "parked before pressing" is checkable. */
function page(): Pointer & { moves: Array<[number, number]> } {
  const moves: Array<[number, number]> = [];
  return {
    moves,
    mouse: {
      async move(x: number, y: number) {
        moves.push([x, y]);
      },
    },
    async evaluate<T>() {
      return undefined as T;
    },
  };
}

/** Fails the given number of times with the message Playwright uses for a covered element. */
function target(interceptions: number): ClickTarget & { attempts: number } {
  return {
    attempts: 0,
    async click() {
      this.attempts++;
      if (this.attempts <= interceptions) {
        throw new Error(
          'locator.click: Timeout 2500ms exceeded.\n  - <div>Go to profile</div> from ' +
            '<div data-radix-popper-content-wrapper=""></div> subtree intercepts pointer events',
        );
      }
    },
  };
}

describe('click', () => {
  it('parks the pointer away from the last click before pressing', async () => {
    const p = page();
    await click(p, target(0), VIEWPORT);
    expect(p.moves).toEqual([[VIEWPORT.width - 1, VIEWPORT.height - 1]]);
  });

  it('parks again and retries when a hover card covers the control', async () => {
    const p = page();
    const control = target(1);
    await click(p, control, VIEWPORT);
    expect(control.attempts).toBe(2);
    expect(p.moves).toHaveLength(2);
  });

  it('gives up when the second press is blocked too, rather than looping', async () => {
    const control = target(2);
    await expect(click(page(), control, VIEWPORT)).rejects.toThrow('intercepts pointer events');
    expect(control.attempts).toBe(2);
  });

  it('does not retry a failure that is not an interception', async () => {
    const control: ClickTarget & { attempts: number } = {
      attempts: 0,
      async click() {
        this.attempts++;
        throw new Error('locator.click: Timeout 2500ms exceeded.');
      },
    };
    await expect(click(page(), control, VIEWPORT)).rejects.toThrow('Timeout');
    expect(control.attempts).toBe(1);
  });
});
