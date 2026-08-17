# Performance — where a crawl spends its time

Measured on Bluesky (`.sandbox/bluesky`, `localhost:19006`) logged out, with `JSXRAY_TRACE=1`.
Bounds: `maxDepth 6 · maxStates 25 · actionCap 10 · timeoutMs 600000 · capture.delayMs 2000`.
References like §7 point at [technical.md](technical.md).

> **13.2 seconds a click became 2.2.** The run that used to stop on the 10-minute clock now runs
> out of things to click in 52 seconds. Everything below is what was in the way, in the order it
> was found — because each fix uncovered the next one.

## Before and after

| | 2026-08-13 | 2026-08-17 |
|---|---|---|
| Wall clock | **608s** — stopped by the clock | **52s** — stopped by an empty frontier |
| Seconds per click | 13.2s | **2.2s** |
| Clicks | 46 | 24 |
| States worked | 5 | 8 |
| States recorded | 21 | 6 |
| Runtime edges | 37 | 13 |

Fewer states and fewer edges, and that is the point of §4 below: 15 of the old 21 were one post
each, and 24 of the old 37 edges were the same feed→post line drawn again. The map lost nothing a
reader can see.

## 1. Getting back to a screen cost more than everything else

**What it was.** §7.4 backtracked by replay: after every click, the state's steps were re-run from
the start, each one a full page load — 3.9s × 91 replays, a third of the run. The page was ready in
~0.3s; `navigate()` then waited for `networkidle` with a 5s cap, and a live app never goes quiet.

**Fixed.** `networkidle` is gone, and backtracking climbs four rungs and stops at the first that
works (§7.4): already there → a `pushState` the router hears → a load → the full replay, now the
rare last resort. `goto()` settles before it returns, so no caller settles twice for one move.

| | Before | After |
|---|---|---|
| Getting back to a state | 7.0s | **2.8s** |
| One move | 3.9s | **2.1s** |

The 2.1s that remains is Bluesky rendering a feed, and it is charged once per backtrack instead of
once per replayed step.

## 2. The queue grew as fast as the walk emptied it

**What it was.** Every action on every screen, breadth-first. At 13.2s an action and
`maxStates: 300` the walk could reach 3000 actions — about 11 hours. That is what read as a loop.

**Fixed.** §7.12, three rules: one link per target screen, then unseen routes before known ones,
then skip a line the map already holds. On this run they took 17 actions out of the walk as
`known-target` before a single click was spent on them.

## 3. Every capture paid a fixed 4.3s

**What it was.** §7.10 held `capture.delayMs` and settled again before every shot — 2s + 2.3s,
charged whether or not the screen was ready. 25 captures cost 107s.

**Fixed.** Read the screen, hold only while it says `loading`, at most three times (§7.10). Eight
captures on this run cost **0.0s** of holding, because all eight screens were already there. The
picture-only waits — fonts, images, animations — moved out of `settle()` and into `screenshot()`,
where they belong.

## 4. Content became screens

**What it was.** Feed posts and profile rows are clickable, so the walk spent 13s a click on news
articles and minted a state per post.

**Fixed.** One screen per route pattern, and the exception that matters: **an overlay is its own
state** (§3.1), so `…$feed-menu` is still worth reaching. This is most of the drop from 21 states
to 6.

## 5. Blocked clicks — and the two failures hiding behind them

The run before the pointer-parking fix (§7.11) had **233** blocked clicks, each waiting the full
timeout. Interception is now its own diagnostic code, and working on that turned up a second
failure wearing the same coat: **the ref matched nothing at all.**

A ref is a path through the DOM, and Bluesky rewrites that path as the feed streams in. Nine of 26
clicks in an intermediate run were pressing at a path the app had moved. Three fixes, in §7.10 and
§7.11:

- `settle()` waits for the control count to hold still, so refs are collected from a page that has
  finished arriving rather than one still building.
- A ref that matches nothing is asked about before the press, not discovered by waiting out 2.5s.
- Before giving up, the control is looked up again by **what it is** — its label and its target —
  and pressed at its new path.

Six remain on this run, reported as `action-ref-stale` rather than folded into `action-failed`.

## 6. What the capture is a picture of

`captureStatus` replaced the two-value `captureSkipped`: `ok · loading · blank · privacy ·
failed · not-run` (§7.8). A skeleton that outlasts its holds is captured **and labelled**, instead
of being passed off as the screen. All eight captures on this run came back `ok`.

## The whole app, unbounded

The runs above were rooted at the wrong directory and enumerated no routes, so they seeded only
`/`. Rooted at the app, `enumerate` finds **74 screens**, and the crawl runs to an empty frontier
in **631s — 10.5 minutes**, logged out. It is not stopped by anything: not the clock, not
`maxStates`, not depth.

| | |
|---|---|
| Wall clock | 631s |
| States recorded | 52 |
| Runtime edges | 21 |
| Clicks | 72 |
| Captures `ok` / `loading` | **14 / 38** |
| Holding | 234s — **37% of the run** |

**Two thirds of the map is an auth wall, and the document says so.** 38 of 52 screens came back
`loading`: logged out, `/moderation/*`, `/notifications/*` and `/sys/*` render a skeleton that
never resolves, because the data behind them needs a session. Under the old two-value
`captureSkipped` all 38 would have shipped as ordinary captures that *look* like the screen.

That is also where the remaining time goes. Each of those screens takes one hold — 6.2s, and it
would be three but for the rule that a hold which changes nothing on the page stops the retries.
Without it this run would have been about 700s of holding alone.

**21 edges for 52 states.** Most of the map was seeded by URL, not clicked into (§7.1), because a
screen with nothing on it offers nothing to click. This is problem 6 above, and logged out it is
not a crawl defect — it is the app.

## 7. What is left

**Waiting for the screen is now the whole cost.** Of 52 seconds, 25 went on history moves and 6.6
on loads — Bluesky painting a feed. That is real work, not overhead, and it is bounded by the
4-second ceiling in `settle()`.

**The action cap is now the binding constraint, not the clock.** This run left 20 actions untried
as `cap` and ended with an empty frontier at 52s of a 600s budget. A click that costs 2.2s instead
of 13.2s can afford a much larger cap, and that is where the next coverage comes from — the same
app at `actionCap: 25`:

| `actionCap` | Wall clock | Clicks | Per click | Edges | Untried by `cap` |
|---|---|---|---|---|---|
| 10 | 52s | 24 | 2.2s | 13 | 20 |
| 25 | 63s | 36 | **1.7s** | 16 | **5** |

Half again as many clicks for 11 more seconds, and the cap almost stops binding. The default is
still 10, because the cap is what stops a crawl on an app the clock would not.

**A ref goes stale more often the deeper the walk goes.** 6 of 24 at `actionCap: 10`, 13 of 36 at
25, and **27 of 72** on the full unbounded run — the extra actions are further down feeds, which is
exactly where an app rewrites its DOM most. This is now the largest single defect left in a run.
Matching a control by label recovers many of them; matching by something the app owns, such as a
`testID`, would recover the rest.

**Still open.** `empty-state` and `not-found` need to read the words on a screen
([expo-map](expo-map.md) §3). Interactions seen but never taken should feed the coverage
denominator, not only `untriedActions` ([revyl](revyl.md) §7). And on the drawing side: place
edgeless nodes in a grid rather than one long row (expo-map §8), and draw thinned links dashed
rather than hiding them (revyl §6).

## What the prior art does instead

Neither comparable project pays this cost, because neither resets.
[expo-map](expo-map.md) walks forward on a simulator and writes each step down as a replayable
flow, deriving its edges from that log afterwards. [revyl](revyl.md) taps forward on a device with
the search kept in the model's head.

Both are cheaper and neither is reproducible. Our reset is what §8 determinism and the persona diff
are built on. The answer was not to copy the walk — it was to keep the reset and make it cheap.

## Reproducing the trace

```
JSXRAY_TRACE=1 npm run jsxray -- run -c .sandbox/bluesky/jsxray.config.ts \
  --persona anon --max-states 25 --timeout 600 2> trace.log
```

`--timeout` is in seconds. The trace writes to stderr and is silent unless the variable is set. It
prints one line per state (depth, steps, frontier size, budget, total states) and, inside a state,
the milliseconds for each rung of the backtrack, collect, every action, every observe, the classify,
any hold, and each screenshot.
