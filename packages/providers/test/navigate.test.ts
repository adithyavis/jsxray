import { describe, expect, it } from 'vitest';
import { navigate, type Navigable } from '../src/renderer/playwright/index.js';

/** Records what a navigation asked of the page, and can fail on cue. */
function fakePage(failures: unknown[]): Navigable & { gotos: string[]; waits: string[] } {
  const queue = [...failures];
  return {
    gotos: [],
    waits: [],
    async goto(url: string) {
      this.gotos.push(url);
      const failure = queue.shift();
      if (failure) throw failure;
      return null;
    },
    async waitForLoadState(state: string) {
      this.waits.push(state);
    },
  };
}

const aborted = (): Error => new Error('page.goto: net::ERR_ABORTED at http://localhost:3000/login');

describe('navigate', () => {
  it('goes once when nothing is in the way', async () => {
    const page = fakePage([]);
    await navigate(page, 'http://localhost:3000/login');
    expect(page.gotos).toEqual(['http://localhost:3000/login']);
  });

  it('lets the navigation in front land, then asks again', async () => {
    const page = fakePage([aborted()]);
    await navigate(page, 'http://localhost:3000/login');
    expect(page.gotos).toEqual([
      'http://localhost:3000/login',
      'http://localhost:3000/login',
    ]);
    // The wait between the two attempts is the point: retrying into the same race
    // would abort again.
    expect(page.waits[0]).toBe('load');
  });

  it('gives up when the retry aborts too, rather than looping', async () => {
    const page = fakePage([aborted(), aborted()]);
    await expect(navigate(page, 'http://localhost:3000/login')).rejects.toThrow('ERR_ABORTED');
    expect(page.gotos).toHaveLength(2);
  });

  it('rethrows anything that is not a lost race', async () => {
    const page = fakePage([new Error('net::ERR_CONNECTION_REFUSED')]);
    await expect(navigate(page, 'http://localhost:3000/login')).rejects.toThrow(
      'ERR_CONNECTION_REFUSED',
    );
    expect(page.gotos).toHaveLength(1);
  });
});
