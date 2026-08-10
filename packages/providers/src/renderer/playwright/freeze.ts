/** §8 — what to freeze. Injected before any app code runs. */

const FIXED_EPOCH_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z

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

export const FREEZE_SCRIPT = `
(() => {
  const FIXED = ${FIXED_EPOCH_MS};
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
 * Hydration replaces nodes after load, so a click on an element found before it
 * lands hits a detached node. Wait for the DOM to stop mutating.
 */
export const SETTLE_PAGE = `
(async () => {
  const cap = (promise, ms) =>
    Promise.race([Promise.resolve(promise).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

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
 */
export const WAIT_FOR_QUIET_DOM = `
(() => new Promise((resolve) => {
  const QUIET_MS = 200;
  const FLOOR_MS = 150;
  const CEILING_MS = 4000;

  setTimeout(() => {
    let timer = setTimeout(done, QUIET_MS);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, QUIET_MS);
    });
    const ceiling = setTimeout(done, CEILING_MS);
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
