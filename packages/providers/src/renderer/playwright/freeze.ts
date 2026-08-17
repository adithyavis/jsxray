/** §8 — what to freeze. Injected before any app code runs. */

// in the future, also suppport react native
export const FREEZE_STYLE = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
::-webkit-scrollbar { display: none !important; }
html { scrollbar-width: none !important; }
`;

export const freezeScript = (epochMs: number): string => `
(() => {
  const FIXED = ${epochMs};
  const RealDate = Date;

  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) return new RealDate(FIXED).toString();
    return args.length === 0 ? new RealDate(FIXED) : new RealDate(...args);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = () => FIXED;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;

  let tick = 0;
  performance.now = () => (tick += 16);

  let seed = 42;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // Injected once per document, not once per settle — re-injecting is itself a mutation.
  const applyStyle = () => {
    if (document.getElementById('jsxray-freeze')) return;
    const element = document.createElement('style');
    element.id = 'jsxray-freeze';
    element.textContent = ${JSON.stringify(FREEZE_STYLE)};
    (document.head ?? document.documentElement).append(element);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
  } else {
    applyStyle();
  }
})();
`;

/**
 * §7.10 — what a *screenshot* needs and an action does not. Fonts and images are
 * about the picture, so waiting for them before every click charged up to four
 * seconds a move to something only the shutter cares about. `screenshot()` awaits
 * this; `settle()` does not.
 */
export const AWAIT_PAINT = `
(async () => {
  const cap = (promise, ms) =>
    Promise.race([Promise.resolve(promise).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

  // §8 — scroll is pinned, and the shutter is the place that has to be sure of it.
  window.scrollTo(0, 0);
  await cap(document.fonts.ready, 2000);
  await cap(
    Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map((image) => image.decode().catch(() => undefined)),
    ),
    2000,
  );
  await cap(
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
    1000,
  );
})()
`;

/**
 * Clock-free on purpose: `Date.now` and `performance.now` are both pinned by the
 * freeze, so the only usable time source in the page is `setTimeout` itself.
 * The floor exists because a click handled in a React transition has not started
 * its work — or its fetch — by the time the click resolves.
 *
 * §7.10 — a quiet DOM is not the same as an arrived screen. An SPA goes quiet for
 * a moment between its shell and its first paint, and reading the page there finds
 * a splash with nothing on it to press. Two more conditions than quiet, therefore:
 * the page classifies as something other than `loading`, and its control count has
 * stopped changing. The second is what stops the crawl reading a half-built screen
 * and collecting refs that are stale by the time it presses them.
 */
export const waitForQuietDom = (classify: string): string => `
(() => new Promise((resolve) => {
  const QUIET_MS = 200;
  const FLOOR_MS = 150;
  const CEILING_MS = 4000;
  const CONTROLS = 'a[href],button,[role=button],[role=link],[role=menuitem],[role=tab],input,select,textarea';
  const ready = () => ${classify} !== 'loading';
  const controls = () => document.querySelectorAll(CONTROLS).length;
  // Twice in a row, because an app that arrives in chunks pauses between them and
  // one steady window lands inside the pause.
  const STEADY_ROUNDS = 2;
  let counted = -1;
  let steady = 0;
  let mutations = 0;

  window.scrollTo(0, 0);
  setTimeout(() => {
    let timer = setTimeout(check, QUIET_MS);
    const observer = new MutationObserver(() => {
      mutations++;
      clearTimeout(timer);
      timer = setTimeout(check, QUIET_MS);
    });
    const ceiling = setTimeout(done, CEILING_MS);
    function check() {
      const now = controls();
      steady = now === counted ? steady + 1 : 0;
      counted = now;
      // A page that has not mutated once is not building itself, so there is
      // nothing to wait for it to finish — server-rendered HTML answers here.
      if ((mutations === 0 || steady >= STEADY_ROUNDS) && ready()) return done();
      timer = setTimeout(check, QUIET_MS);
    }
    function done() {
      clearTimeout(timer);
      clearTimeout(ceiling);
      observer.disconnect();
      resolve();
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }, FLOOR_MS);
}))()
`;
