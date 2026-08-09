# jsxray — technical spec

> Scope legend: **v1** the shipping target · **v2** a declared seam, specified but not built.
> Companion to [product.md](product.md). Decisions and their reasons are in §17.

No code exists yet — this spec is written for a fresh build. Where product.md carries ✅ marks
from the previous implementation, read them as intent rather than status.

---

## 1. Architecture

```
    source                         running app + credentials
       │                                               │
       ▼                                               ▼
  ┌────────┐   ┌───────┐   ┌───────────┐   ┌───────┐   ┌╌╌╌╌╌╌╌╌╌╌┐
  │ detect │──▶│ parse │──▶│ enumerate │──▶│ crawl │──▶┊ link  v2 ┊
  └────┬───┘   └───┬───┘   └─────┬─────┘   └───┬───┘   └╌╌╌╌╌┬╌╌╌╌┘
       │           │             │             │             │
       ▼           ▼             ▼             ▼             ▼
  ╞══════════════════════════ jsxray.json ════════════════════════╡
                                   │
                                   ▼
                  viewer (canvas) · future consumers
```

**One rule governs everything: `jsxray.json` is the API.** It is not the output of the chain —
it is the medium the chain runs on. Each stage reads the whole document, adds its own fields,
and hands the same document to the next. Providers write only through the stage that selected
them, and consumers read the finished document and nothing else. The viewer holds no analysis
logic; if it has to compute something interesting, that computation belongs in a stage.

**The chain is linear, but the crawl's only hard dependency is `detect`** — which picks the
renderer and the auth provider. The static half *guides* the runtime half: the route manifest is
the crawl's checklist and the nav intents are its planner hints (§5). It is not a precondition.
A crawl seeded from `config.seedRoutes` runs with no router provider at all (§4.3); what it loses
is coverage's denominator, not the ability to walk the app.

### Packages

| Package | Owns | Scope |
|---|---|---|
| `@jsxray/core` | schema, config, pipeline, `detect`, route identity, safety guard, the four provider interfaces | v1 |
| `@jsxray/providers` | every provider, one directory each, **named for its provider id**: `parser/react`, `router/next`, `router/tanstack-router`, `router/react-router`, `auth/username-password`, `renderer/playwright` — in v2 `parser/vue`, `router/expo-router`, `renderer/native` | v1 |
| `@jsxray/viewer` | the canvas (Vite + React + React Flow) | v1 |
| `jsxray` (cli) | `run` / `view` / `init`, provider registry, static server | v1 |

**A heavy dependency earns an optional peer, not a package.** The renderer looks like the one axis
that must be split out — Playwright plus its browsers is hundreds of megabytes, and
`run --static-only` should not pay for it. But the weight is in the *dependency*, not the adapter:
the Playwright provider is a few hundred lines and costs nothing to ship. So `@jsxray/providers`
declares `playwright` as an **optional peer dependency**, npm does not install it, and the CLI
resolves it at `crawl` time and prints an install instruction when it is absent. Same saving, one
fewer package.

This matters because the renderer is the axis that *will* multiply. Playwright drives browsers; it
cannot drive an iOS simulator, so native is a second renderer with its own heavy, platform-gated
peer (§4.4). Package-per-renderer would have reintroduced precisely the sprawl that moving the
routers into directories was meant to remove.

What is left is four packages, split by build target and role rather than by provider: interfaces,
implementations, a browser app, and the published entry point. `@jsxray/viewer` stays separate
because it is a Vite build emitting two browser bundles — a genuinely different artifact, not a
different provider.

**There is no third-party provider API.** The supported set is finite, named in §4.3, and grows by
a pull request rather than through a plugin contract. That is a deliberate narrowing: publishing a
provider interface would freeze the four axes long before the runtime half has taught us what they
should be, and an in-house router is not yet a case worth paying that price for.

So adding TanStack Router, expo-router, or a native renderer is a **directory**. A tenth provider
is a tenth folder, not a tenth artifact to publish and version against core — which matters because
every provider depends on core's interfaces, and package-per-provider means one interface change
fans out into eight releases users can then mismatch.

`detect` lives in core rather than behind a provider, because it is what *chooses* the providers —
an axis cannot select the thing that selects it.

Workspace: npm workspaces. TypeScript project references; the viewer builds with Vite and is
typechecked separately (Vite does not typecheck).

## 2. The document

`schemaVersion: 1`. Bump on any breaking change; `view` refuses a mismatch.

| Field | Written by | Meaning | Scope |
|---|---|---|---|
| `framework` | detect | stack profile — a matrix, with `evidence` | v1 |
| `providers` | pipeline | which provider served each of the four axes | v1 |
| `components` | parse | id, name, file, source location; `isPage` marks the ones a router can mount | v1 |
| `navIntents` | parse | source facts in the author's terms, before the router turns them into edges (§4.1) | v1 |
| `components[].renders/guards/props` | parse | the full component graph | v2 |
| `screens` | enumerate + parse | route facts, root component, layouts | v1 |
| `screens[].tree/layoutTrees` | parse | static component trees | v2 |
| `edges` | enumerate + crawl | navigation, `discoveredBy: static \| runtime` | v1 |
| `personas` | config | declared roles | v1 |
| `states` | crawl | observed screen states, per persona, with captures and the renderer that produced them | v1 |
| `states[].deadActions` | crawl | interactions that changed nothing — recorded once, never retried, never an edge | v1 |
| `coverage` | pipeline | reached ÷ declared and confirmed ÷ matchable, plus the unmatchable count (§5.1), per persona | v1 |
| `diagnostics` | all | levelled, stage-tagged, with source locations | v1 |
| `stages` | pipeline | which stages actually ran | v1 |
| `boxes` | link | rendered rect → component → source location | v2 |

v2 fields are declared in the schema now and land empty in v1, so adding them later is a fill,
not a version bump.

**Invariants**

- **Two path classes, both relative, both POSIX.** *Source* paths (`file`, `loc`) are
  repo-relative. *Asset* paths (captures) are **document-relative**, because the document moves
  with `-o/--out` and its assets move with it. Absolute paths never appear except `root`.
- **Output layout.** `run` writes `.jsxray/jsxray.json` and captures to `.jsxray/assets/`, so a
  capture path reads `assets/user/dashboard.png`. `-o/--out` relocates that whole directory; the
  document is self-contained wherever it lands.
- Component id = `<repo-relative file>#<name>`. Stable across runs.
- The document is JSON-serializable with no cycles.
- Absent data is `null` or `[]` — never a placeholder that looks real.
- **Kind identifiers admit values outside the supported set.**

The last one exists for diagnostics, not for extensibility. `ui`, `metaFramework`, `router`, and
`Guard.kind` are typed as their known values *plus* `string`, because **`detect` has to be able to
name a stack it cannot analyze.** "Detected `svelte-kit`; no router provider supports it" is a far
more useful document than `router: 'unknown'`, and in aggregate those diagnostics are the roadmap.
Known values keep their autocomplete; the widening is what makes honest degradation expressible.

## 3. Screen identity

The dedup and merge key, because everything downstream — persona diffing, graph size, coverage —
depends on it.

1. **Canonicalize the pattern.** `[id]` → `:id`, `[...slug]` → `*slug`, `[[...slug]]` → `*slug?`.
   React-router `:id` and `*` pass through.
2. **Canonicalize observed URLs** against the declared patterns first (real param names), falling
   back to an id-shape heuristic (numeric, UUID, ObjectId, long opaque) so a crawl can dedup
   routes the static half never declared.
3. **Screen id = canonical route**, suffixed with `#` when something else shares that route:
   `/#not-found`, `/api/health#route-handler`, `#intercepted`. Without this, `not-found.tsx` at
   the router root shadows `/`.
4. **Sub-states** — overlays over a route (modals, sheets, drawers) — get a **state signature**,
   which uses `$`. The two separators are deliberately different: `#` disambiguates *screens*
   sharing a route, `$` names *states* over a screen. Sharing one would collide `/` with a
   "Not Found" modal over it.

Pattern matching prefers literal segments over dynamic ones, and longer patterns over shorter —
`/tx/new` wins over `/tx/:id`.

**The canonical route is a string identity the router provider defines, not necessarily a URL
path.** For URL routers it is the path, which is what every example here shows. For a name-based
router — React Navigation's `navigation.navigate('Details')` — it is the navigator path,
`Root/Tabs/Details`. Nothing downstream cares which: dedup, coverage, and the canvas need the
identity to be stable and comparable, not to be a URL.

### 3.1 The state signature — sub-states are overlays

A sub-state is an **overlay over the page**: modal, bottom sheet, drawer, popover, alert. Anything
else that moves — a list gaining rows, an accordion, a tab — is the same screen and gets no node.

```
stateSignature = screenId                              // base state
               = screenId + '$' + overlayName          // one segment per overlay above it
               = screenId + '$' + outer + '$' + inner  // stacked, outermost first
```

**Detection**, from the accessibility tree, in order: role `dialog`/`alertdialog` or `aria-modal`
(where React Native's `Modal` also lands) · a native `<dialog open>` or open popover · the rest of
the page marked `aria-hidden`/`inert`, which is how Radix, Headless UI, and MUI signal a modal
when the role is missing.

**Identity is the overlay's accessible name**, slugified — `/settings$confirm-deletion`. Readable,
stable across runs, and a node title for free. An unnamed overlay falls back to a hash of its own
subtree, never the page's. Stacked overlays append in stacking order, outermost first:
`/settings$manage-billing$confirm-deletion`.

The narrowness is the point. A hash of the whole page forks `/inbox` every time a message arrives,
because twelve rows and thirteen are different structures — excluding *text* does not fix that.
Scoping to overlays lets page data churn freely, hashes less, and degrades quietly: an overlay
with no role, no name, and no inert background is simply not a node.

A static component tree could not do this job at any scope, which is the real reason it is not
used: `/settings` is one source file whether the modal is open or shut.

## 4. Provider axes

Four independent axes, all four populated in v1. Each provider declares `capabilities` and
answers `supports(profile)`, so the core degrades with a diagnostic instead of throwing.
Selection is by `supports` then `priority`.

| Axis | Interface highlights | v1 | v2 |
|---|---|---|---|
| **Parser** | `parse(files, recognizers) → {components, navIntents, fileExports}` | `react` | `vue`; `buildTree()` |
| **Router** | `enumerate() → {screens, edges}`, `recognizers`, `navEdges(screens, intents)` | `next` (app + pages), `tanstack-router`, `react-router` (file mode) | `expo-router`, `vue-router`, `react-navigation`, `react-router` (code mode) |
| **Renderer** | `launch(baseUrl) → session · goto(target) · settle · fingerprint · overlays · screenshot · clickables · forms · tap · fill · freeze · session` | `playwright` | `native` — Appium or Maestro (§4.4); `elementBoxes` |
| **Auth** | `login(session, credentials, loginFlow)`, `isLoggedIn?` | `username-password` | firebase / amplify / jwt |

**Renderer is one interface for both web and native** so crawl logic stays target-agnostic.
`launch()` opens a session per persona (§7); four more members exist specifically for the crawl
and are worth naming:

- `settle()` — wait for navigation, network idle, and animation completion to converge.
- `overlays()` — modals, sheets, and drawers above the page; what identity is built from (§3.1).
- `fingerprint()` — a broad page digest. Not identity: it answers "did anything happen" (§7.2).
- `forms()` — form controls with `type`, `name`, `label`, `autocomplete`, `required`, and the
  submit control, which is what §7.3 synthesizes against.

`elementBoxes()` stays on the interface as a v2 member; a provider that cannot produce boxes says
so through `capabilities` rather than throwing.

**`config.loginFlow` is the auth provider's script, not a parallel mechanism.** The crawl only ever
calls `auth.login(session, credentials, loginFlow)`; the provider decides what to do with the
flow. `username-password` replays `loginFlow.steps` verbatim, or synthesizes them from the login
page's `forms()` when the flow is absent. A future provider (jwt, firebase) may ignore
`loginFlow` entirely and seed the session directly. **`isLoggedIn` is optional** — a provider that
cannot cheaply answer it omits it, and the crawl skips the check (§7.6).

**Router discovery is ranked, not binary.** A router declares the strategies it has and tries them
in order: a **generated** route tree is authoritative and needs no convention-guessing (TanStack
Router emits `routeTree.gen.ts`, and reading it beats inferring anything); a **file** convention is
deterministic; a **config** tree parsed from source is the fallback. `capabilities.discovery` is
that ordered list, not a `fileBased` boolean — one router usually has several strategies, and
which one applies is a property of the target repo, not of the provider.

### 4.1 Parser ↔ router boundary

The parser emits **nav intents** — source facts, in the author's terms (`kind`, `target`,
`targetExpression`, `componentId`, `loc`, `trigger`). The router turns intents into **edges** —
route facts. The parser knows syntax; the router knows routes.

But the parser cannot *recognize* a navigation on its own, because what a navigation looks like is
a property of the routing library, not of the language:

| Router | Declarative | Imperative |
|---|---|---|
| Next | `<Link href="/posts/1">` | `router.push('/posts/1')` |
| TanStack Router | `<Link to="/posts/$id" params={…}>` | `useNavigate()({ to: '/posts/$id' })` |
| Vue Router | `<router-link to="/posts/1">` | `router.push({ name: 'post' })` |
| React Navigation | — | `navigation.navigate('Details', { id })` |

Different prop, different call shape, different target syntax, and in one case no declarative form
at all. So **the router supplies the recognizers and the parser applies them**:

```ts
interface NavRecognizers {
  /** Element + the prop carrying the target: {Link, href} · {Link, to} · {router-link, to} */
  linkProps: { element: string; prop: string }[];
  /** Call shapes that navigate, and where the target sits in the arguments. */
  calls: {
    callee: string;                        // 'router.push', 'navigation.navigate'
    kind: NavEdgeKind;
    target: { arg: number; key?: string }; // positional, or a key in an options object
  }[];
}
```

One parser per language, one router per routing library, and the parser still knows nothing about
routes. Without this split a TanStack app yields zero nav intents, and the crawl loses its
guidance entirely (§5) — silently, because "no links found" is indistinguishable from "app has no
links".

### 4.2 What a non-React or non-web target must not break

Vue and React Native are v2, but the interfaces are fixed in v1, so the places those targets press
on the design are worth naming now. Each is cheap to honour today and expensive to retrofit.

| Assumption | Where it would leak | How it is avoided |
|---|---|---|
| Elements are JSX | schema, trees | the model says *element usage*, not JSX: `name` + `props` + nesting describes a Vue template node as well as a JSX one. "JSX" appears only in §11, which is the React parser's own rules |
| Conditions are `&&` and ternaries | `Guard.kind` | an open string; Vue contributes `v-if` / `v-else` / `v-show`. The **polarity invariant** (§11.3) is the part that actually has to hold, and it is language-neutral |
| A route target is a URL path | §3, `goto` | the canonical route is a router-defined string identity (§3) |
| Navigation happens over HTTP | `RendererSession.goto` | `goto(target)` takes a router-supplied target, not a URL. Playwright resolves it to an address; a native renderer resolves it to a deep link or a navigation action |
| Structure comes from the DOM | §3.1 state signature | the fingerprint is over the **accessibility tree**, which web and native both expose. Chosen for a different reason, and it is what makes the signature portable |
| Sessions are cookies | `SessionState` | opaque and renderer-owned. A renderer that cannot persist one declares `sessionPersistence: false`, and the crawl logs in per persona instead |
| A form is a `<form>` | §7.3 | `forms()` returns a provider-identified *group* of controls plus a submit control. React Native has no form element; a set of `TextInput`s and a button is the same thing |
| Freezing means `addInitScript` | §8 | §8's table is *what* to freeze; the injection point belongs to the renderer |

What genuinely does not port is the **renderer**, and that is the axis that exists for it.

### 4.3 What is actually supported

The set is finite and named. Everything else is detected, reported, and degraded around.

| Router | Discovery | Scope |
|---|---|---|
| `next-app`, `next-pages` | file | v1 — the anchor |
| `tanstack-router` | generated → file | v1 — `routeTree.gen.ts` is authoritative, which makes this nearly free, and it is what covers Vite |
| `react-router` (framework mode) | file | v1 — the largest install base, and its file convention is deterministic |
| `react-router` (`createBrowserRouter`) | config | v2 — the first user of the `config` strategy |
| `expo-router` | file | v2 — the same convention family as Next, but it wants the native renderer to be worth much |
| `vue-router`, Nuxt | file / config | v2 — needs the Vue parser first |
| `react-navigation` | config | v2 — name-based routes and no URLs; the hardest of the set |

Three v1 routers rather than one, because they cost very little together: Next and react-router
file mode are the same kind of directory walk, and TanStack hands over a generated route tree that
needs no convention-guessing at all.

**Degrading when nothing applies.** `detect` still names the router it found, `enumerate` skips
with a diagnostic naming both the detection and the supported set, and the run continues. That
matters more than it first appears: **the crawl does not require a router provider.** Seeded from
`config.seedRoutes` it discovers screens purely at runtime, and the canvas is built from runtime
edges regardless (§5). What is lost is the route manifest — so coverage has no denominator and
reports `null` instead of a ratio it cannot honestly compute.

An unsupported stack therefore produces a thinner map, not a failed run.

### 4.4 The native renderer

Playwright drives browsers. It cannot drive an iOS simulator or an Android emulator, so Expo and
React Native on a device need a second renderer — and it is worth naming which, because the most
obvious candidate is disqualified by the product rather than by the engineering.

| Candidate | Verdict |
|---|---|
| **Appium** (XCUITest / UiAutomator2) | the conservative choice. WebDriver protocol, black-box, and its accessibility-tree model maps onto `fingerprint`, `clickables`, and `forms` almost directly |
| **Maestro** | lighter, also black-box, also accessibility-tree driven. The better fit if its control surface proves rich enough for `forms()` |
| **Detox** | **disqualified.** It links into the app build, and product §2 forbids instrumenting app code |

Either peer is heavy and platform-gated — an iOS simulator needs Xcode, so those runs are
macOS-only — which is exactly why the renderer resolves lazily.

**Expo on the web is already covered.** An Expo app runs in a browser through React Native Web, so
`renderTarget: 'native'` plus Playwright at a phone viewport produces a usable map today. That
splits Expo support into two halves that ship independently: `router/expo` is a v2 *router* that
pays off immediately against the web build, while a native renderer is needed only for real device
chrome and native-only surfaces.

That intermediate has to stay honest, so **every capture records the renderer that produced it**.
A phone-viewport browser screenshot of an Expo app is a legitimate artifact; presenting it as a
device capture without saying so is not (product §7.2).

## 5. Static analysis is crawl guidance

The static half has two consumers, and neither of them is the canvas.

| Static output | Consumer | Use |
|---|---|---|
| **Route manifest** | crawl, coverage | the checklist of what to try, and the denominator of "screens reached ÷ screens declared" |
| **Candidate transitions** | crawl planner | which control on this screen is worth clicking first, and what route it probably leads to |

Candidates are recorded in the document as `discoveredBy: 'static'`. **The canvas renders only
`discoveredBy: 'runtime'`.** A declared link is a hypothesis; a traversal is a fact, and the
canvas shows facts (product §7.2).

Two consequences to state now rather than discover later:

- **A static-only run produces a document with candidate edges and a canvas with none.**
  `enumerate` does write edges; the canvas simply does not draw hypotheses. That is what makes the
  runtime half load-bearing rather than optional.
- **Coverage is two ratios, not one**: `screensReached ÷ screensDeclared` and
  `edgesConfirmed ÷ edgesMatchable`, each overall and per persona. The second is what tells a
  reader whether the map is thin because the app is thin or because the crawl stalled.

### 5.1 Matching a runtime edge to the candidate it confirms

**The match key is `(sourceScreenId, targetScreenId)`** — canonical screen ids on both ends,
overlay segments dropped, so `/posts$share` confirms a candidate out of `/posts`. Screen id
already canonicalizes params (§3), so a candidate `/posts/:id` and a traversal of `/posts/42`
match. A candidate matching several traversals is confirmed once; the extra traversals are edges
in their own right.

Many candidates have no target at all (§11.2) and therefore no key. So candidates fall into
**three** buckets, not two:

| Bucket | Meaning |
|---|---|
| `confirmed` | a runtime edge shares its key — the declared link was traversed |
| `unconfirmed` | it has a key, and no traversal matched it — the crawl did not get there |
| `unmatchable` | no static target (`<Link href={item.path}>`, a built template) — unknowable without the runtime |

`edgesMatchable = confirmed + unconfirmed`. **Unmatchable candidates are excluded from the
denominator and reported as their own count**, because scoring them as misses would make a
CMS-driven app look like a stalled crawl. They still do their real job: telling the planner there
is a control here worth clicking.

## 6. Pipeline stages

Each stage is JSON-in → JSON-out: independently testable, resumable, cacheable.

| Stage | Reads | Writes | Failure mode |
|---|---|---|---|
| `detect` | package.json, config files, filesystem | `framework` | throws only if there is no package.json |
| `parse` | source files, **the router's `recognizers`** (§4.1) | `components`, nav intents | per-file diagnostic; the run continues |
| `enumerate` | router root, nav intents | `screens`, candidate `edges` | diagnostic naming the detected router and the supported set (§4.3); the run continues without a manifest |
| `crawl` | running app | `states`, runtime `edges` | diagnostic if no URL, no renderer, or login fails |
| `link` | rendered elements ↔ source | `boxes` | v2 |

`detect` is mandatory — every later stage selects providers from its output. `--stages` selects a
subset; `detect` is always prepended.

**Provider selection happens once, at the end of `detect`, for all four axes.** The stage order is
about who *writes* the document, not who is chosen when: `parse` runs before `enumerate` but needs
the router's `recognizers` (§4.1), so the router is resolved a stage earlier than the table's
reading order suggests. When no router applies, `parse` runs with an empty recognizer set and
yields components but no nav intents — a diagnostic, not a failure.

### 6.1 Which files get parsed

The app dir, **plus every workspace package the app depends on** — those are source in this repo,
not opaque dependencies.

The parser declares its own cheap pre-filter, because what makes a file uninteresting is
language-specific: for React it is a file with neither JSX nor `export`, which can hold neither a
component nor a re-export.

### 6.2 What v1 asks of `parse`

Only what the route manifest and the crawl need:

- **Which component does this file mount** — the default export, with re-exports folded to a
  fixed point.
- **Nav intents** — every `<Link>`, `router.push`, `redirect` and friends, with target, source
  text, trigger label, owning component, and location.

The full component graph — `renders`, `guards`, prop signatures, expanded trees — is a widening of
this same stage in v2, not a new one. The interfaces carry the fields from the start.

## 7. The crawl

The section this spec exists for. Per persona: launch → **freeze** → authenticate → traverse.
Freeze comes before login because login is app code, and on an SPA the app boots once and never
reloads — a freeze applied after it has already missed the values the app read at module scope
(§8).

```
visit(state) =                                        # one place, so no rule is skippable
  if match(state.route, ignore.screenshots): state.capture ← null       # privacy
  else:                                    state.capture ← screenshot()
  return state

for each persona P:
  session ← renderer.launch(baseUrl)
  session.freeze()                                    # §8 — before any app code runs
  if P.login: auth.login(session, credentials(P), config.loginFlow)   # env, in memory only
  visited ← ∅

  # Phase 1 — named flows first: they reach gated states reliably
  for each flow applicable to P:
    replay(flow.steps), recording every transition as a runtime edge
    for each state reached:                           # the gated states the flow exists to reach
      visit(state); visited.add(state.signature); frontier.push(state, depth 0)

  # Phase 2 — seeds: config.seedRoutes ∪ declared page routes
  for each route ∉ ignore.navigation:
    goto(route); state ← observe()                    # a node, not an edge
    if state.signature ∈ visited: continue            # Phase 1 already has it
    visit(state); visited.add(state.signature); frontier.push(state, 0)

  # Phase 3 — bounded interaction walk
  while frontier and budget remains:
    (state, depth) ← frontier.pop()
    if depth ≥ maxDepth or match(state.route, ignore.actions): continue
    reEstablish(state)
    for action in guard.filter(clickables() ∪ forms())[:actionCap]:   # drops ignore.navigation
      before ← (url, overlays, fingerprint)
      perform(action); settle()
      if (url, overlays, fingerprint) == before: record dead action; continue
      next ← observe()
      if match(next.route, ignore.navigation):        # a redirect landed us somewhere banned
        diagnostic; reEstablish(state); continue      # no capture, no edge, no frontier entry
      visit(next)
      recordRuntimeEdge(state → next, label = action)
      if next.signature ∉ visited: visited.add(next.signature); frontier.push(next, depth+1)
      reEstablish(state)
```

`observe()` reads url, overlays, and fingerprint — it never captures. Capture is `visit()`'s job
alone, which is what makes `ignore.screenshots` unskippable.

box = node = framed screenshot
```
  ┌──────────┐        ┌──────────┐
  │ [screen- │  tap   │ [screen- │
  │  shot]   │───────▶│  shot]   │
  └──────────┘        └──────────┘
     Login              Dashboard
```

### 7.1 Two ways to reach a state; only one makes an edge

A direct `goto` of a declared route yields a **node**. Only a traversed interaction yields an
**edge**. This is what the edge decision means operationally: seeding by URL buys coverage cheaply
without inventing a transition nobody performed.

### 7.2 Observing the result of an action

Two questions, two signals — answering both with one is how a multi-step form stops being walked.
`overlays()` decides identity; `fingerprint()` only decides whether anything happened at all.

After `settle()`:

| Change | Meaning |
|---|---|
| URL changed | a new screen — canonicalize, dedup by screen id |
| URL same, overlays changed | a sub-state (§3.1) |
| URL same, overlays same, fingerprint changed | the page moved but made no node — a list grew, a tab switched, a wizard advanced. **Not dead**: the crawl carries on, same node |
| nothing changed | a dead action — recorded once, no edge, not retried |

The third row is why `fingerprint()` survives §3.1's narrowing: a form advancing a step has
plainly done something, and scoring it dead would abandon the flow one step in.

### 7.3 Forms

A form is **one action**: fill every synthesizable field, then activate the submit control.
Values come from the strongest available signal, and a config `flow` overrides any of them.

| Signal | Value |
|---|---|
| `type=email`, `autocomplete=email` | `jsxray@example.com` |
| `type=tel`, `autocomplete=tel` | `5550100000` |
| `type=url` | `https://example.com` |
| `type=number` | `min` if present, else `1` |
| `type=date` / `time` | a fixed constant — a synthesized "today" would break determinism (§8) |
| `<select>` | the first non-empty option |
| `checkbox` / `radio` | left at its default unless `required` |
| name or label matches `name` | `Test` |
| any other `type=text` | `jsxray` |
| `type=password` | **never synthesized** — a password outside the login flow is a signup; declare it as a flow |
| name or label matches `card`, `cc`, `cvv`, `cvc`, `expiry`, `iban`, `routing` | **never filled, and the whole form is skipped**, with a diagnostic |

The payment refusal is a hard built-in, not a default the user can relax. A required field with no
synthesizable value and no config override skips the form with a diagnostic, rather than
submitting something half-filled.

### 7.4 Backtracking by replay, not history

Browser back is unreliable in SPAs — it may restore a route without restoring the state that made
it interesting. Re-reach a state by `goto` on its URL plus replaying the `reachedVia` step prefix
that produced it. Every state therefore stores the ordered steps that reached it, which is also
what the inspector shows a reader.

### 7.5 Bounds

`maxDepth`, `maxStates`, a per-state action cap, and a wall-clock budget. **Every bound that
truncates emits a diagnostic**, so a partial crawl never reads as a complete one — the honesty
rule that governs the canvas, applied to the numbers behind it.

### 7.6 Session drop

**Only when there is a session to drop.** A persona with no `login` is a first-class persona — the
logged-out visitor is exactly the role most apps render most differently — and it is never
checked. Neither is a persona whose auth provider omits the optional `isLoggedIn`.

Where both exist, call `auth.isLoggedIn` before each frontier pop; on failure, re-login and
re-establish the state before continuing. A crawl that silently continues logged-out produces a
map of the login wall.

### 7.7 Personas

The crawl runs end-to-end per persona, and states carry `personaId`. One graph keyed by **state
signature** (§14), with per-persona variants on each node — not N separate maps. A state two
personas both reached is one node holding two captures.

In v1 the evidence is entirely runtime: *this persona reached this state, that one did not*. The
static side of product §9 — annotating each element with the `{isAdmin && …}` guard that gates it
— arrives with the component graph in v2. The persona toggle is honest either way, because
"unreached by this persona" is a fact the crawl establishes on its own.

## 8. Determinism

Freezing is a **precondition of capture**, not a post-process. It is what makes two runs diffable,
which is what makes J6 possible later.

| Source of variance | Freeze |
|---|---|
| Animation, transitions | emulate `prefers-reduced-motion: reduce`, and inject a stylesheet zeroing `animation-duration` / `transition-duration` |
| Time | pin `Date.now`, `new Date()`, `performance.now` via an init script, before any app code runs |
| Randomness | seed `Math.random` from the same init script |
| Fonts | await `document.fonts.ready`; capture only after |
| Images | await decode — a half-loaded image is a different screenshot every run |
| Scroll, carets, scrollbars | reset to top, hide the caret, hide scrollbars |

The table is *what* to freeze and is universal; the injection point belongs to the renderer. On the
web it is an init script, because it has to land before the first line of app code — a patch
applied after load has already lost the values the app captured at module scope. A native renderer
freezes the same list at its own entry point, and declares `determinismFreeze: false` if it
cannot, so a run that is not reproducible says so rather than pretending.

## 9. Safety and privacy

Three orthogonal rules. A two-rule model cannot express the third, which is why they are named
separately here.

| Rule | Meaning | Kind | Enforced at |
|---|---|---|---|
| `ignore.navigation` | never click through to these routes | safety — protects the session | `guard.filter`, the seed loop, and post-hoc on the landed route |
| `ignore.actions` | visit and capture, but perform no interaction here at all | safety | the frontier pop |
| `ignore.screenshots` | visit and interact, but never capture | privacy | `visit()` — the single call site of `screenshot()` |

**All three lists are globs**, matched with picomatch against the canonical route. A bare
`/settings/secrets` is therefore an exact match for that one route; write `/settings/secrets/**`
to include what is below it. Built-in denylist entries are globs by the same rule.

**A redirect can land the crawl on an ignored route**, because the ban is known by destination and
the destination is known only after the click. Two fallbacks, in order: an `ignore.navigation`
landing is discarded entirely — no capture, no edge, no frontier entry, one diagnostic — and any
landing is re-tested against `ignore.screenshots` before capture, so the privacy rule holds even
for a route the crawl never intended to reach.

Enforcement:

- A built-in route denylist (logout, delete, pay, checkout confirm, subscription cancel) plus
  built-in unsafe-label regexes. **User rules extend the built-ins; they never replace them.**
- Matched on the **target** *and* on the visible label. A destructive control often has no target
  at all, and on a native target there is no href to match in the first place.
- Credentials resolve from environment variables at run time, live in memory, and reach neither
  the config, nor `jsxray.json`, nor any log. Config stores the *name* of the variable.
- Screenshots capture real authenticated data. `init` scaffolds the warning to use a test account.

## 10. Config

`jsxray.config.ts` lives in the target app. Everything has a default; the file exists for what
cannot be inferred — the URL, credentials, named flows, and exclusions.

```ts
export default defineConfig({
  url: 'http://localhost:3000',
  personas: [
    { id: 'anon' },                                     // no login — a persona, not an absence
    { id: 'user',  login: { username: env('USER_EMAIL'),  password: env('USER_PW') } },
    { id: 'admin', login: { username: env('ADMIN_EMAIL'), password: env('ADMIN_PW') } },
  ],
  loginFlow: { start: '/login', steps: [ /* fill / tap */ ] },  // handed to auth.login (§4)
  flows: [ /* named deep-path flows */ ],
  seedRoutes: ['/', '/dashboard'],
  ignore: {                               // all three are globs over the canonical route (§9)
    navigation:  ['**/beta'],             // never click
    screenshots: ['/settings/secrets'],   // visit ok, never capture — privacy
    actions:     ['**/logout'],           // no actions, for safety
  },
});
```

Loaded with jiti, so a `.ts` config needs no build step. `env(name)` returns a marker object, not
a value — the value is read during `crawl` and never serialized.

A persona without `login` is the logged-out visitor and is crawled like any other (§7.6). When
`personas` is omitted entirely, that persona is the default.

## 11. Parser rules (React)

One parser per language. These are the React parser's rules; a Vue parser answers the same
questions about `.vue` SFCs — the default export or `<script setup>` for the component, `v-if` /
`v-show` for guards — and returns the same shapes. Nothing in §1–§10 is written in terms of JSX,
and that is deliberate (§4.2).

### 11.1 Page component discovery

A file's page component is its default export. Accepted shapes: capitalized function declarations,
arrow/function variables, `memo(...)`, `forwardRef(...)`, classes extending
`Component`/`PureComponent`, and anonymous default exports (named from the file).

A candidate qualifies if its body contains JSX **or** calls one of Next's render-nothing functions
(`redirect`, `notFound`, `permanentRedirect`, `forbidden`, `unauthorized`) — a page whose whole
job is to redirect is still the component the router mounts.

Re-exports (`export { default } from './x'`, `export * from './x'`) are folded into the export
index to a fixed point (capped at 5 passes) before resolution, so a forwarding page resolves to
the real component.

### 11.2 Nav intents

The parser matches the **recognizers the router handed it** (§4.1) — it does not know that Next's
target prop is `href`. For each match it records the static target when the argument is a literal,
the source text always, the visible label of the trigger when statically known, the owning
component, and the location.

Two shapes need care because they are where a literal target is absent:

- `<Link href={item.path}>` over CMS data yields an intent with **no target**. Correct, and still
  useful — it tells the crawl planner there is a link worth clicking here, which is exactly what §5
  wants from it.
- A target assembled from parts (`` `/posts/${id}` ``) records the template as `targetExpression`
  and leaves `target` null. Reconstructing the route is the router's job, not the parser's, and
  usually the crawl answers it first.

### 11.3 Guards *(v2)*

`{cond && <X/>}`, `||`/`??` fallbacks, both ternary branches, and if/else early returns, each with
source text, kind, location, and referenced identifiers.

**Polarity invariant, fixed now so v2 cannot get it wrong: `condition` always reads as "renders
when this holds".** An else branch or a `||` fallback is stored negated (`!(user)`), so a consumer
never has to consult `kind` to know which way it points.

### 11.4 Design-system detection *(v2)*

Three shapes, because real repos use all three, often at once:

| Source | Rule |
|---|---|
| **Package** | known names, plus membership of a design-system **scope** (`@radix-ui/*`, `@mui/*`) — a hand-maintained list of Radix's ~30 packages goes stale immediately |
| **Vendored directory** | conventional homes (`components/ui`, `src/ui`, `design-system`) holding ≥3 component files; `class-variance-authority` / `tailwind-merge` corroborate |
| **Workspace package** | a linked workspace package whose name or directory reads as UI — parsed as source, so its components get real files and source locations |

**Alias re-exports** belong here rather than in §11.1: `const Dialog = DialogPrimitive.Root`,
where the root binding is imported, is a design-system named export, not a page component. A
router never mounts one, so v1 has no use for it.

Where a vendored primitive wraps a package one, the seam is recorded:
`components/ui/dialog.tsx#Dialog` → `aliasOf: DialogPrimitive.Root` → `@radix-ui/react-dialog`.

## 12. Module resolution

This is where the worst bugs live; the rules are explicit for that reason. It is load-bearing in
v1, not v2 detail — resolution is what makes "which component does this route mount" correct.

| Specifier | Rule |
|---|---|
| `./x`, `../x` | relative to the importer; try extensions, then `index.*` |
| `@acme/ui`, `@acme/ui/button` | **workspace package** — resolve into its source dir, preferring `source`/`publishConfig.source` over `main`/`module` (which point at build output that may not exist) |
| `@/components/x` | tsconfig `paths`, longest pattern first |
| `components/layout/nav` | **`baseUrl` fallback** — TypeScript resolves bare specifiers against `baseUrl`; lowest priority |
| `./x.js` resolving to `x.tsx` | **the NodeNext convention** — TypeScript ESM imports carry a `.js` extension that never exists on disk. Without this, `export { default } from './page.js'` resolves to nothing and the screen has no component |
| `react`, `@mui/material` | left unresolved on purpose — "came from `@mui/material`" is more useful than a path into `node_modules` |

`tsconfig.json` is **JSONC parsed with a real scanner**, not regexes. Its own data is full of
comment-like text: `"@/*"` opens what looks like a block comment and `"**/*.ts"` in `include`
closes it.

Resolution order for an identifier: local component → import specifier → export lookup → **the
file, even when no export matched** (an icon registry or a hook still has a knowable home) → bare
package name → unresolved. Never discard a resolved file.

## 13. Router rules (Next)

Segment semantics, isolated for unit testing:

| Segment | Effect |
|---|---|
| `(marketing)` | route group — not in the URL, recorded as `meta.groups` |
| `@modal` | parallel slot — not in the URL |
| `_private` | opted out of routing entirely — **no screen** |
| `(.)x`, `(..)x` | intercepting — URL segment kept, id suffixed |
| `[id]`, `[...s]`, `[[...s]]` | dynamic params |

Pages Router: the filename is the last segment; `index` maps to its directory;
`_app`/`_document`/`_error` are not screens; `pages/api/**` are route handlers.

Layouts are collected from the router root down to the page, outermost first. Route handlers get
no navigation edges and are never crawled — they render no UI.

**A dynamic route needs a concrete param to be visited.** The crawl gets one from a named flow, or
from a link it traversed to reach the route. A `/tx/:id` that is never linked to and never named
in a flow stays unreached, and is reported as unreached rather than guessed at.

## 14. Viewer

Vite + React + React Flow. Reads `window.__JSXRAY__` when inlined, otherwise fetches
`./jsxray.json`. Two build outputs from one source: `dist/` (served by `view`) and `dist-single/`
(one self-contained file, for `--export`).

**A node is a state, not a screen.** One `/settings` with two modals is three nodes, keyed by state
signature (§3.1). This settles the question §7.7 and §3.1 left open from opposite ends: the graph
is keyed by state, and a screen is what a group of states has in common, not a node. It follows
from what an edge is — an edge is a traversed interaction, opening a modal *is* a traversed
interaction, and an edge needs somewhere to land.

**Node** — a device frame; phone for native targets, browser for web, reader-overridable. Frame
geometry is fixed per device, so a capture and a not-yet-captured state occupy the same box and
dropping captures in later shifts no layout. The frame holds the capture, or an explicit empty
state saying the crawl has not run. There is no wireframe.

**Node anatomy** — three derived strings, computed in the viewer only because they are
presentation, not analysis:

| Part | Rule |
|---|---|
| Eyebrow | first `meta.groups` entry — a Next route group is exactly this idea already, a grouping that never touches the URL — falling back to the parent path segment. Never the screen's own last segment, which would echo the title back as its own section. |
| Title | canonical route, de-slugged and title-cased; a dynamic route becomes `<Words> Detail`; an entirely dynamic route (`/*slug`) is named after its parameter, which is what the author called it. `/` is `Home`. An overlay state is titled by its **last `$` segment** — the overlay's own accessible name, de-slugged — which is why §3.1 built identity from that name. |
| Caption | the interaction count in and out, and the capture's persona. |

**Chrome** — dark ground; a dot grid whose spacing is fixed in screen space, so it does not
scale with zoom; a vertical brand rail; square zoom controls bottom-left.

**Non-page screens** — route handlers and error states render no UI and are never crawled, so
they have no capture and do not belong on the flow canvas. They are reachable from `--list` and
from a separate listing in the viewer, not as nodes (product §11.2).

**Edges** — runtime only (§5); curved, single-arrowed, labelled with the interaction that caused
the transition. One edge per pair even when several interactions share it.

**Layout** — a **tree layout**, `elkjs` `elk.mrtree` (Reingold–Tilford) with direction `RIGHT`.
Every state is a consequence of the state before it, so depth reads left to right and siblings
fan out vertically, centred on their parent:

```
                       ┌──────────┐
                    ┌ ▶│ [screen- │
                    │  │  shot]   │
                    │  └──────────┘
  ┌──────────┐      │  ┌──────────┐
  │ [screen- │  tap │  │ [screen- │
  │  shot]   │────────▶│  shot]   │
  └──────────┘      │  └──────────┘
                    │  ┌──────────┐
                    └─▶│ [screen- │
                       │  shot]   │
                       └──────────┘
```

**This replaces the vertical stacking product §7 originally asked for.** Variants of one screen do
end up stacked — a modal over `/settings` is a child of `/settings` — but as siblings in the tree,
not as a special case, and the same rule places every other fan-out.

Fall back to `elk.layered` (layer-sweep crossing minimization, `considerModelOrder` so discovery
order drives flow order) when back-edges make the graph a genuine DAG, which `mrtree` cannot lay
out. Product §7 asks for no crossing edges, and that is tractable only because runtime edges are
confirmed BFS traversals: the graph is near-tree by construction. A graph with every declared link
drawn — including the ones a nav bar produces out of every screen — is dense enough that no layout
engine could oblige.

**Inspector** — in v1: route facts, the steps that reached the state, outgoing confirmed
transitions, and which personas reached it. The component tree, props, and design-system origin
(product §7.1, rows 2–3) arrive with the v2 component graph.

**Typing note.** React Flow node data must be indexable. Keep the fields in their own interface and
intersect with `Record<string, unknown>`: `keyof` an index-signature type is `string | number`, so
`Omit` over it silently drops every named field.

## 15. CLI

| Command | Flags |
|---|---|
| `run` | `-c/--config`, `-u/--url`, `-o/--out`, `-s/--stages`, `--static-only`, `--persona`, `--headed`, `--max-states`, `--timeout`, `-q/--quiet` |
| `view` | `-c/--config`, `-f/--file`, `-p/--port`, `-l/--list`, `-e/--export`, `--no-open` |
| `init` | `-f/--force` |

`-o/--out` defaults to `.jsxray/` and names a **directory**, not a file: the document lands at
`<out>/jsxray.json` and captures at `<out>/assets/` (§2). `init` adds `.jsxray/` to `.gitignore`.

`view` serves the viewer bundle, `jsxray.json` at a stable path, and the asset directory beside
it. Rules, all of them learned the hard way:

- Requests that escape either served root are rejected; unknown paths fall back to the SPA shell.
- **Response headers are not written until the file is known readable.** Writing them first and
  then calling `writeHead` from the stream's error handler throws `ERR_HTTP_HEADERS_SENT` and
  takes the server down.
- `clientError` and `error` are handled so no single request ends the session.

## 16. Testing

| Layer | What it proves |
|---|---|
| Unit (`core`, `providers/router/next`, `providers/parser/react`) | route identity, state signatures, safety guard, credential handling, segment semantics, module resolution, form-value synthesis |
| Static e2e (`cli`) | the static pipeline over `fixtures/next-app` and `fixtures/monorepo` — the contract test for `jsxray.json` |
| **Runtime e2e (`cli`)** | login, crawl, form traversal, capture, runtime edges, bound truncation, session recovery |
| Server (`cli`) | serving rules, path traversal in three encodings, survival when the document is deleted |
| Canvas (`viewer`) | the graph is non-empty, positioned, non-overlapping, correctly labelled; empty states render where captures are missing |
| Smoke (`scripts/smoke.mjs`) | real cloned repos — resolution rate, screens found, warnings, wall time |

The runtime layer needs a fixture that actually boots, and that is a **different fixture from the
static one**.

Tests run against `src` via vitest aliases, never `dist`. Fixtures prove the shapes we thought of;
the smoke harness finds the ones we did not — every item in §17.2 came from it.

## 17. Decisions

### 17.1 Standing decisions

| Decision | Reason |
|---|---|
| `jsxray.json` is the sole contract | keeps providers, viewer, and future consumers decoupled |
| npm workspaces, not pnpm | corepack could not resolve pnpm here; nothing in the design needs pnpm |
| Parser emits intents, router makes edges | keeps the two axes independent across frameworks |
| **The router supplies the nav recognizers** | what a navigation *looks like* is a property of the routing library, not the language — `<Link href>` vs `<Link to>` vs `navigation.navigate` |
| **Providers are directories; a heavy dependency earns an optional peer, not a package** | the weight is in the dependency, not the adapter — and the renderer is the axis that multiplies, so package-per-renderer would rebuild the sprawl |
| **Captures record their renderer** | an Expo app photographed in a phone-viewport browser is honest only if the document says so |
| **No third-party provider API; a finite supported set** | publishing the interface would freeze the four axes before the runtime half has taught us their shape |
| **Kind ids admit unknown values** | `detect` must be able to name a stack it cannot analyze; in aggregate those diagnostics are the roadmap |
| **Router discovery is a ranked list** | a generated route tree beats a file convention beats a parsed config, and which applies is a property of the repo |
| **Canvas draws runtime edges only** | a declared link is a hypothesis, a traversal is a fact; the canvas shows facts |
| **A node is a state, not a screen** | opening a modal is a traversed interaction, and an edge needs somewhere to land |
| **Tree layout, not stacked variants** | every state is a consequence of the one before it, so variants are siblings and one rule places every fan-out |
| **`loginFlow` is data for the auth provider** | one call site (`auth.login`) rather than two mechanisms that can disagree |
| **Static analysis is crawl guidance** | it earns its keep as the checklist and the planner's hints, not as canvas output |
| **Capture or an explicit empty state** | a wireframe is a second thing to build and maintain that no reader asked for |
| **v1 is J1+J2 end-to-end** | the unproven risk is crawl-and-capture on an unseen app, so retire that one first |
| **Forms synthesized, payments refused** | reaching post-form screens is the point; a card field is where "observes, does not assert" would break |
| Runtime state signature | describes what the persona actually saw, and needs no component tree |
| Layout trees beside the screen tree *(v2)* | chrome belongs to every wrapped screen; `{children}` position is unknowable |
| Guards stored in positive polarity *(v2)* | a consumer should not need `kind` to read a condition |
| Viewer holds no analysis logic | anything interesting belongs in a stage, in the document |

### 17.2 Requirements learned from real repos

Each of these was a genuine bug in the previous implementation, surfaced by running the static
half over cloned repos (taxonomy, commerce, platforms, dub). They are requirements now rather than
history — the consequence column is why.

| Requirement | Consequence of getting it wrong |
|---|---|
| Parse JSONC with a real scanner | regex stripping deleted `paths` from every standard Next tsconfig — **no alias resolved anywhere**, silently |
| Honour `baseUrl` without `paths` | commerce: 1 nav edge instead of 39 |
| Design systems are packages *or* directories *or* workspace packages | shadcn/ui — the dominant React pattern — invisible |
| Match design-system scopes, not names | Radix's ~30 packages missed |
| Alias re-exports are components | vendored primitives unresolvable |
| Follow `export { default } from` | those screens had no component |
| Redirect-only pages are components | those screens had no component |
| Parse workspace packages as source | dub: design-system coverage 22% instead of 51% |
| Negate ternary / `\|\|` guards | both branches read as the same condition |
| Keep node data fields out of the index signature | `Omit` silently typed them away, and Vite did not typecheck |
| Open the stream before writing headers | deleting `jsxray.json` crashed the server → blank canvas |
| Resolve a `.js` specifier to its `.ts`/`.tsx` source | `export { default } from './page.js'` resolved to nothing, so those screens had no component |
| Split identifiers on camelCase before matching field names | `name="cardNumber"` with no label slipped past the payment refusal; `\bcard\b` does not match inside `cardNumber` |
| The renderer resolves a control's kind in the page, not from an attribute | filling a `<select>` with `fill()` throws, and the whole form traversal dies one field in |

## 18. Known limits

- Config-defined route trees (`react-router`'s `createBrowserRouter`, `react-navigation`, TanStack
  in code mode) are detected but not parsed in v1. Generated and file-based route trees were the
  deterministic win; the `config` discovery strategy (§4) is declared so a provider can add one
  without a redesign.
- Routers outside the §4.3 set are detected and reported, never analyzed, and there is no plugin
  interface to add one. The crawl still runs from `seedRoutes`; coverage reports `null`.
- A dynamic route never linked to and never named in a flow stays unreached. jsxray reports it
  rather than inventing a param.
- ~4% of JSX in a large app is unresolvable and always will be statically: components passed as
  props (`<Icon/>`) or returned from a hook. The runtime half is the answer, not more parsing.
- Auth beyond username/password is a seam. Anything with a second factor is out of reach in v1.
- A crawl sees one moment of one account's data. Screens whose existence depends on data the test
  account lacks will not appear — coverage reports them as unreached.
- Prop signatures resolve type literals and same-file interfaces; imported prop types are not
  followed. *(v2)*
