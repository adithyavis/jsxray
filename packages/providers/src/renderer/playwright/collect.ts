/** In-page collectors. Evaluated as strings so nothing is bundled into the app. */

const PREAMBLE = `
const visible = (el) => {
  if (!(el instanceof Element)) return false;
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
};

const cssPath = (el) => {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) {
      parts.unshift('#' + node.id);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
};

const digest = (value) => {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

const labelOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const title = el.getAttribute('title');
  if (title) return title.trim();
  const text = (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
  return text.length ? text.slice(0, 120) : null;
};

const inOverlay = (el) => Boolean(el.closest('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]'));
`;

/** §3.1 — three signals, in order. */
export const COLLECT_OVERLAYS = `(() => {
${PREAMBLE}

  const found = new Map();

  const add = (el, via) => {
    if (!el || found.has(el) || !visible(el)) return;
    const heading = el.querySelector('h1,h2,h3,[role=heading]');
    const name = el.getAttribute('aria-label')
      ?? (el.getAttribute('aria-labelledby')
        ? (document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ?? '').trim()
        : '')
      ?? '';
    const resolved = (name || (heading?.textContent ?? '')).replace(/\\s+/g, ' ').trim();
    found.set(el, {
      name: resolved.length ? resolved.slice(0, 80) : null,
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      via,
      subtreeHash: digest(el.outerHTML.slice(0, 4000)),
    });
  };

  document
    .querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true]')
    .forEach((el) => add(el, 'role'));

  document.querySelectorAll('dialog[open]').forEach((el) => add(el, 'dialog-element'));
  document.querySelectorAll('[popover]').forEach((el) => {
    if (el.matches(':popover-open')) add(el, 'dialog-element');
  });

  const hiddenSiblings = [...document.body.children].filter(
    (el) => el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert'),
  );
  if (hiddenSiblings.length) {
    [...document.body.children]
      .filter((el) => !hiddenSiblings.includes(el) && visible(el))
      .forEach((el) => add(el, 'inert-background'));
  }

  const depthOf = (el) => {
    let depth = 0;
    let node = el;
    while (node.parentElement) { depth++; node = node.parentElement; }
    return depth;
  };

  return [...found.entries()]
    .sort((a, b) => depthOf(a[0]) - depthOf(b[0]))
    .map(([, overlay]) => overlay);
})()`;

export const COLLECT_CLICKABLES = `(() => {
${PREAMBLE}

  const selector = 'a[href],button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit],input[type=button],summary';
  const seen = new Set();
  const results = [];

  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('form') && el.matches('[type=submit],button:not([type=button])')) continue;

    const ref = cssPath(el);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);

    let target = null;
    const href = el.getAttribute('href');
    if (href && !href.startsWith('#') && !/^(mailto|tel|javascript):/i.test(href)) {
      try { target = new URL(href, location.href).pathname; } catch { target = href; }
    }

    results.push({
      ref,
      label: labelOf(el),
      target,
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      inOverlay: inOverlay(el),
    });
  }

  return results;
})()`;

export const COLLECT_FORMS = `(() => {
${PREAMBLE}

  const controlOf = (el) => ({
    ref: cssPath(el),
    type: el.tagName.toLowerCase() === 'select'
      ? 'select'
      : (el.getAttribute('type') ?? (el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text')),
    name: el.getAttribute('name'),
    label: (() => {
      const id = el.getAttribute('id');
      const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
      const wrapper = el.closest('label');
      const text = (explicit ?? wrapper)?.textContent ?? el.getAttribute('placeholder') ?? '';
      return text.replace(/\\s+/g, ' ').trim() || null;
    })(),
    autocomplete: el.getAttribute('autocomplete'),
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    options: el.tagName.toLowerCase() === 'select'
      ? [...el.options].map((option) => option.value)
      : null,
    min: el.getAttribute('min'),
  });

  return [...document.querySelectorAll('form')]
    .filter(visible)
    .map((form) => {
      const controls = [...form.querySelectorAll('input,select,textarea')]
        .filter((el) => visible(el) && !['hidden'].includes(el.getAttribute('type') ?? ''))
        .map(controlOf);

      const submitEl =
        form.querySelector('[type=submit]') ??
        form.querySelector('button:not([type=button]):not([type=reset])');

      const heading = form.querySelector('legend,h1,h2,h3');
      return {
        ref: cssPath(form),
        label: form.getAttribute('aria-label') ?? (heading ? labelOf(heading) : null),
        controls,
        submit: submitEl
          ? {
              ref: cssPath(submitEl),
              label: labelOf(submitEl),
              target: null,
              role: 'button',
              inOverlay: inOverlay(submitEl),
            }
          : null,
      };
    })
    .filter((form) => form.controls.length > 0 && form.submit !== null);
})()`;

/**
 * Is there anything on screen at all? An error shell, a redirect that resolved to
 * nothing, a bare API response — each leaves a body that paints no text and no
 * mark, and a screenshot of that is a white rectangle claiming to be a screen.
 * A blank capture is worse than no capture: the viewer has an empty state for
 * "nothing rendered" and none for "this is what the screen looks like" (§14).
 */
export const PAINTS_SOMETHING = `(() => {
  ${PREAMBLE}
  const body = document.body;
  if (!body) return false;
  if ((body.innerText ?? '').trim().length > 0) return true;

  // Text is the usual evidence; a mark is the rest of it — a chart, a logo, a
  // control with no label. Anything else on a textless page is empty scaffolding.
  const MARKS = 'img,svg,canvas,video,picture,iframe,object,embed,input,button,select,textarea';
  return [...body.querySelectorAll(MARKS)].some(visible) ||
    [...body.querySelectorAll('*')].some(
      (el) => visible(el) && getComputedStyle(el).backgroundImage !== 'none',
    );
})()`;
