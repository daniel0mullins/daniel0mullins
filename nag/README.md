# Nag

An intentionally annoying task tracker for ADHD/AuDHD brains.

You write down the thing, you give it a time, and when that time comes Nag
asks one question, full screen, and will not go away: **Is this complete?**
You can say yes, you can snooze (each snooze shorter than the last), or you
can hit the panic button and admit you are out of spoons. Everything you do
is logged, and the Friction dashboard tells you which *kinds* of task you
actually get done and which ones you keep pushing away.

There is no account, no server and no build step. State lives in the
browser's local storage. The same files run as a website, install as a PWA,
and wrap into an iOS app.

## Running it

The app is written as ES modules, so it has to be served over HTTP rather
than opened from `file://`:

```sh
cd nag
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

The **Simulate time** panel at the bottom of the Tasks screen moves the app's
clock forward (+5 min, +1 hour, +1 day, or straight to the next alert) so
you can watch the whole nag loop in a minute instead of an afternoon. A
yellow banner shows while the clock is simulated; reloading resets it.
**Load demo data** (Settings, or the empty state) seeds three weeks of
history so the dashboard has something to say.

## Publishing to GitHub Pages

Everything is static, so Pages can serve the directory as-is.

1. Merge this branch into `main`.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   pick branch `main` and folder `/ (root)`, and save.

This repository is `daniel0mullins/daniel0mullins`, so Pages publishes it as
the user site at `https://daniel0mullins.github.io/`, and the app lands at
**https://daniel0mullins.github.io/nag/**. `.nojekyll` tells Pages to serve
the files untouched. Enabling Pages publishes the *whole* repository, which
is fine for a public profile repo.

Served over HTTPS the app is installable: the manifest and service worker
give it a home-screen icon and offline start-up (network first, cache as
fallback, so updates land as soon as you are online).

## Wrapping it for iOS

Two options, depending on how native you want to go.

**Capacitor (recommended).** From the repository root:

```sh
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init Nag com.example.nag --web-dir nag
npx cap add ios
npx cap open ios
```

Capacitor serves the files from `capacitor://localhost`, so ES modules,
`localStorage` and the safe-area insets all work unchanged. The layout uses
`viewport-fit=cover` and `env(safe-area-inset-*)`, and every control is at
least 44 px tall. The native app icon comes from the Xcode asset catalog
Capacitor generates; the repository itself keeps to a single SVG icon (add a
PNG `apple-touch-icon` if you also want a home-screen icon for the PWA on
iOS, which ignores SVG there).

**Plain WKWebView.** `npm run build` writes `dist/nag.html`, a single
self-contained file with the CSS and all modules inlined, which loads fine
via `loadFileURL` or `loadHTMLString` without any module or CORS
restrictions. The file is generated, not committed: run the build whenever
you need a fresh copy.

Web notifications cannot fire while an iOS wrapper is in the background, so
the app exposes a small bridge for native local notifications. If the page
finds `window.NagNative` with a `schedule(entries)` function, it calls it
after every change with the pending alerts:

```js
[{ id: 'task-id', title: 'Call the dentist', at: 1789000000000, level: 1 }, ...]
```

`at` is a Unix timestamp in milliseconds; `level` is the escalation level
the alert will carry. A Capacitor plugin (for example `@capacitor/local-notifications`)
can mirror that list into the system scheduler; on tap, open the app and it
shows the same alert dialog, because the task is already in the `alerting`
state.

## How it works

### Tasks and time anchors

Every task has a name, an optional type (`chores`, `admin`, `health`, … or
anything you type), a spoon size and a **time anchor**: a date plus either an
exact clock time or a fuzzy part of the day. Fuzzy anchors resolve to a
clock time from Settings:

| Part of day | Default |
| --- | --- |
| Morning | 09:00 |
| Midday | 12:00 |
| Afternoon | 15:00 |
| Evening | 18:30 |
| Night | 21:00 |

Changing a period time re-anchors tasks that are still waiting on their
original anchor; tasks that have already alerted keep their history.

### Spoons

Spoons (1–5) say how much energy a task takes. Leave it alone and a task is
**2 spoons**. The size sets the first snooze window; it is also one of the
axes the dashboard breaks friction down by.

### The nag loop

```
scheduled ──fire──▶ alerting ──complete──▶ done
    ▲                 │  │
    │        snooze ──┘  └── out of spoons
    │                 │            │
    │                 ▼            ▼
    │             snoozed       deferred
    │                 │            │
    └──────fire───────┴────fire────┘
```

* **Fire.** A one-second tick fires every waiting task whose time has come.
  Alerts queue up; the most escalated one is shown first, and the dialog
  cannot be dismissed with Escape or a click outside. Sound, vibration and
  a system notification (if allowed) go with it, and an unanswered alert
  re-pulses every 30 seconds (configurable).
* **Yes.** The task is done. Completion time, lateness and every snooze are
  kept for the dashboard. Tasks can also be completed early from the list.
* **Snooze.** The menu depends on spoon size and escalation level, and no
  option may be as long as the snooze you chose last time:

  | Spoons | First alert | After 1 snooze | After 2 | After 3 | After 4 |
  | --- | --- | --- | --- | --- | --- |
  | 1 | 3 / 5 / 10 min | 1 / 3 / 5 | 1 | 1 | 1 |
  | 2 | 5 / 10 / 20 min | 3 / 5 / 10 | 1 / 3 | 1 | 1 |
  | 3 | 10 / 20 / 40 min | 5 / 10 / 20 | 3 / 5 | 1 / 3 | 1 |
  | 4 | 23 / 45 / 90 min | 11 / 23 / 45 | 6 / 11 | 3 / 6 | 1 |
  | 5 | 45 / 90 / 180 min | 23 / 45 / 90 | 11 / 23 | 6 / 11 | 3 |

  Each level halves the durations, drops the generous options, and bottoms
  out at a one-minute nag. The alert itself escalates through four tiers:
  calm (amber), firm (orange), loud (red, throbbing) and hostile (dark red,
  shaking), with copy to match.
* **Out of spoons.** Parks the task until tomorrow, the start of next week
  or the first of next month, always at your configured day-start time. The
  cascade resets when it comes back, so you get the full menu again, but the
  deferral is logged and counts double in the friction score.

### Friction analytics

The dashboard scores every type of task (and every spoon size and part of
the day) by the snoozes it accumulates:

* **Volume**: total snoozes.
* **Frequency**: snoozes per task, and the share of tasks that needed at
  least one snooze.
* **Friction per task** = (snoozes × 1 + out-of-spoons × 2) ÷ tasks.
  Under 1 is *easy*, up to 3 is *sticky*, above 3 is *hard*.

Only tasks that have alerted at least once or been completed are counted, so
a task you added for next week does not dilute the numbers. The page shows
the hardest and easiest types, headline figures (completion rate, done on
first alert, typical lateness, panic-button presses), full tables, and a few
plain-language observations generated from the data.

### Storage

State is saved to `localStorage` under `nag.v1` after every change; if the
browser blocks storage it falls back to memory and says so in Settings.
Corrupt records are dropped on load rather than crashing the app. Settings
has export/import (JSON) and an erase button.

## Tests

```sh
cd nag
npm test        # unit tests: node --test (no dependencies)
npm run e2e     # browser test; needs Playwright with Chromium
npm run build   # generate dist/nag.html (ignored by git)
```

`npm test` covers the time helpers (including daylight-saving edges), the
snooze policy invariants (every level strictly shorter, down to the
one-minute floor), the state machine end to end, the alert queue, the
analytics weighting, persistence and the demo generator.

`npm run e2e` (`node test/e2e.mjs --shots ./shots` to keep screenshots)
drives the real UI in Chromium: creates a task, advances the simulated
clock, checks each escalating alert offers only shorter snoozes, parks the
task as out of spoons, completes it, reloads, and reads the dashboard back.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `style.css` | Markup and the design tokens (light and dark, high contrast, reduced-motion aware) |
| `src/app.js` | UI wiring: routing, rendering, the alert dialog, simulation controls |
| `src/model.js` | Task shape, validation, anchors, spoons, settings |
| `src/machine.js` | The state machine: fire, complete, snooze, defer |
| `src/snooze.js` | Snooze menus, deferral dates, urgency tiers |
| `src/scheduler.js` | Which tasks are due, alert ordering, the native schedule |
| `src/state.js` | The app store: applies transitions, ticks, persists, notifies |
| `src/analytics.js` | The friction engine behind the dashboard |
| `src/persist.js` | localStorage adapter with sanitising loader |
| `src/notify.js` | Sound, vibration, system notifications, title flash |
| `src/demo.js` | Deterministic demo history driven through the real machine |
| `src/time.js` | Local-time date arithmetic and formatting |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA install and offline support |
| `test/` | Unit tests and the Playwright end-to-end script |
| `tools/build.mjs` | Single-file bundler for `dist/nag.html` |
