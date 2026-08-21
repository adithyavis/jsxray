# jsxray

A CLI that reads a React project, drives the running app, and produces an
interactive map of every screen wired to the components that build it.

```
jsxray run     # 1. read code (static)  +  2. drive the app (runtime)  → .jsxray/
jsxray view    # open the canvas over .jsxray/jsxray.json
```

**Status:** both halves run end to end. `detect → parse → enumerate` reads your
source; `crawl` logs in per persona, walks the app, and writes captures; `view`
opens the canvas over the result. `link` (rendered-element boxes) is v2.

| Document | What it is for |
|---|---|
| [specs/product.md](specs/product.md) | what jsxray is, who for, the canvas spec, safety commitments, success criteria |
| [specs/technical.md](specs/technical.md) | architecture, the `jsxray.json` contract, provider axes, stage rules, decisions |

The specs are the source of truth for intended behaviour; where code and spec
disagree, that is a bug in one of them.

---

## Quick start

```bash
npm install
npx playwright install chromium    # the crawl drives a real browser
npm run build

cd your-next-app
npx jsxray init      # scaffolds jsxray.config.ts from your detected stack
npx jsxray run       # writes .jsxray/jsxray.json and .jsxray/assets/
npx jsxray view      # opens the canvas in your browser
```

`jsxray run --static-only` needs no config and no running app — it reads your
source and stops before the crawl.

`jsxray view` also takes `--list` for a text listing, and `--export map.html`
to write the canvas, the document, and every capture into one self-contained
file you can send to someone who has neither the repo nor jsxray installed.

---

## `jsxray.json` is the API

One versioned JSON document flows through every stage. Each stage reads it and
adds its own fields; providers and the canvas only ever touch this file.

| Stage | Half | Reads | Writes |
|---|---|---|---|
| `detect` | static | package.json, config files, filesystem | `framework`, `providers` |
| `parse` | static | source files + the router's recognizers | `components`, `navIntents` |
| `enumerate` | static | router root, nav intents | `screens`, candidate `edges` |
| `crawl` | runtime | the running app | `states`, runtime `edges` |
| `link` | runtime | rendered elements ↔ source | `boxes` *(v2)* |

Stages are JSON-in → JSON-out, so each is independently testable and cacheable.
`detect` is the only hard dependency of the crawl: with no router provider the
crawl still runs from `seedRoutes`, and coverage honestly reports `null`.

### Two identities, two separators

`#` disambiguates **screens** that share a route; `$` names **states** over a
screen. So `not-found.tsx` at the router root is `/#not-found`, while a "Not
found" modal over `/` is `/$not-found` — and they never collide.

```
/settings                                  the screen
/settings$rename-workspace                 a modal over it — its own node
/settings$manage-billing$confirm-deletion  stacked, outermost first
```

Observed URLs canonicalize against declared patterns first (`/tx/9182` →
`/tx/:id`), falling back to an id-shape heuristic so the crawl can dedup routes
the static half never declared.

---

## Architecture: four provider axes

Providers are **directories**, not packages. A heavy dependency earns an
optional peer instead — `playwright` is resolved lazily at crawl time.

| Axis | v1 | v2 |
|---|---|---|
| **Parser** — source → components, nav intents | `react` | `vue` |
| **Router** — screens + candidate edges | `next` (app + pages), `tanstack-router`, `react-router` (file) | `expo-router`, `vue-router`, `react-navigation` |
| **Renderer** — drive the app, screenshot | `playwright` | `native` (Appium / Maestro) |
| **Auth** — obtain a session | `username-password` | firebase / amplify / jwt |

The router supplies the **nav recognizers** and the parser applies them — what a
navigation looks like (`<Link href>` vs `<Link to>` vs `navigation.navigate`) is
a property of the routing library, not of the language.

One renderer interface serves web and native, so crawl logic stays
target-agnostic:

```
launch · freeze · goto · settle · url · fingerprint · overlays
screenshot · clickables · forms · tap · fill · session · restore · close
```

---

## What the crawl does

Per persona: **launch → freeze → authenticate → traverse**. Freeze comes before
login because login is app code, and an SPA boots once and never reloads.

1. **Named flows** first — they reach gated states reliably, and every state
   they reach re-enters the frontier.
2. **Seeds** — `seedRoutes` ∪ declared page routes. A direct `goto` yields a
   node, never an edge.
3. **Bounded interaction walk** — click and submit, bounded by `maxDepth`,
   `maxStates`, a per-state action cap, and a wall clock. Every bound that
   truncates emits a diagnostic, so a partial crawl never reads as a complete one.

A form is **one action**: fill every synthesizable field, then submit. Values
come from the strongest available signal (`type=email` → `jsxray@example.com`,
`<select>` → first non-empty option, dates → a fixed constant so runs stay
diffable). Passwords are never synthesized. Payment fields are a hard refusal —
the whole form is skipped with a diagnostic.

### Safety, privacy, determinism

Three orthogonal rules, all globs over the canonical route:

| Rule | Meaning | Kind |
|---|---|---|
| `ignore.navigation` | never click through to these routes | safety |
| `ignore.actions` | visit and capture, but never interact | safety |
| `ignore.screenshots` | visit and interact, but never capture | privacy |

- **Credentials are never persisted.** `env('USER_PW')` records the *name* of an
  environment variable; the value is read at run time, held in memory, and never
  written to config, to `jsxray.json`, or to any log.
- **Logout, delete, pay, and friends are never clicked** — matched on the target
  *and* on the visible label, because a destructive control often has no href.
  Your rules extend the built-in denylist; they cannot replace it.
- **Freeze before capture.** Time, randomness, animation, fonts, images, scroll,
  and carets are pinned before the first line of app code, so two runs of the
  same commit produce the same pixels.
- **A screen must be old enough to be itself.** A settled page can still be a
  skeleton, and a grey approximation of the layout reads as a real screen. So the
  shutter waits until the screen is `capture.delayMs` old (default 3000), counting
  from the navigation or press that started it — a floor, not a sleep, so a screen
  that already took that long waits for nothing. A skeleton still showing when the
  floor runs out is captured and labelled `loading`, not passed off as the screen.
- **Every screen says what its picture is.** `captureStatus` is one of `ok`,
  `loading`, `blank`, `privacy`, `failed` or `not-run`, and the canvas shows it.
- **Every action offered is accounted for.** The ones the crawl never got to are
  listed in `untriedActions` with the reason, so "this screen was exhausted" and
  "the budget ran out here" stop looking the same.

---

## Config

`jsxray.config.ts` lives in your app; `jsxray init` scaffolds it. Everything has
a default — the file exists for what cannot be inferred.

```ts
import { defineConfig, env } from '@jsxray/core';

export default defineConfig({
  url: 'http://localhost:3000',        // jsxray never boots your dev server
  personas: [
    { id: 'anon' },                    // logged-out is a persona, not an absence
    { id: 'user',  login: { username: env('USER_EMAIL'),  password: env('USER_PW') } },
    { id: 'admin', login: { username: env('ADMIN_EMAIL'), password: env('ADMIN_PW') } },
  ],
  loginFlow: {                         // handed to the auth provider as its script
    start: '/login',
    steps: [
      { fill: { '[name="email"]': '{{username}}', '[name="password"]': '{{password}}' } },
      { submit: 'button[type="submit"]' },
    ],
  },
  seedRoutes: ['/', '/dashboard'],
  viewport: ['desktop', 'mobile'],     // photographed at both; the first is the one crawled
  capture: { delayMs: 3000 },          // a screen must be this old before it is worth a shot
  ignore: {
    navigation:  ['**/beta'],
    screenshots: ['/settings/secrets'],
    actions:     ['**/admin/**'],
  },
});
```

Loaded with jiti, so a `.ts` config needs no build step. Omit `loginFlow` and the
`username-password` provider synthesizes one from the login page's own form.

---

## The canvas

**A node is a state, not a screen** — `/settings` with a modal open is a second
node. States lay out as a **tree growing left to right** (`elk.mrtree`), because
every state is a consequence of the one before it; `elk.layered` takes over when
back-edges make the graph a real DAG.

**An edge is named for the transition, not for the words on the control** —
`Navigate to /profile/:name/feed/:rkey`, `Open the rename workspace dialog`. A
button reading "View this user's verifications" is a good button and a bad edge
label: on a line it is longer than the node it points at, and it names where the
reader already is. The control's own words stay in the inspector and in `--list`.

**Only runtime edges are drawn.** A declared link is a hypothesis; a traversal is
a fact, and the canvas shows facts. Where a fact does not exist yet the canvas
says so plainly — a frame with "the crawl has not run" in it, a disabled persona
selector, `coverage: null`. It never invents data.

Route handlers and error states render no UI, so they are never crawled and
never drawn; they live in a separate listing and in `--list`.

---

## Repo layout

```
packages/
  core/         schema, config, route identity, safety guard, provider interfaces, stages
  providers/    every provider, one directory each; playwright is an optional peer
  viewer/       React Flow canvas (Vite app, holds no analysis logic)
  cli/          jsxray run / view / init, provider registry, static server
fixtures/
  next-app/     App Router source: route groups, catch-alls, layouts, a route handler
  monorepo/     workspace whose design system is a linked package
  runtime-app/  a Node server that actually boots — login, forms, a modal, a gated screen
```

## Development

```bash
npm install
npm run build       # tsc -b across the workspace, then the viewer bundles
npm test            # vitest, runs against src (not dist)
npm run typecheck   # includes the viewer — Vite does not typecheck
```

Without installing globally, `npm run jsxray -- <args>` runs the CLI from source
— but with the repo root as its working directory, so it looks for the document
there rather than in your app. To point it at an app, run it from that app's
directory:

```bash
cd fixtures/runtime-app
node ../../fixtures/runtime-app/server.mjs &      # something to crawl
npx tsx ../../packages/cli/src/bin.ts run
npx tsx ../../packages/cli/src/bin.ts view --list
```

### Testing

| Layer | What it proves |
|---|---|
| Unit (`core`) | route identity, state signatures, safety guard, form synthesis, JSONC scanning |
| Static e2e (`cli`) | the static pipeline over `fixtures/next-app` and `fixtures/monorepo` |
| Runtime e2e (`cli`) | login, per-persona gating, overlay states, form traversal, captures, the privacy rule |
| Server (`cli`) | serving rules, path traversal, survival when the document is deleted |
| Canvas (`viewer`) | runtime-only edges, one node per state, non-overlapping tree layout, node anatomy |
