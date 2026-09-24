# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/kanso.js audit <url>  # Audit a page from the terminal (npm run kanso -- audit <url>)
node bin/kanso.js audit dist   # Audit a build directory, served by Kanso for the audit
node bin/kanso.js discover dist [--write]  # Find the page's states, print them or write .kanso/states.yml
node bin/kanso.js mcp          # Serve the audit to a coding agent over MCP (stdio)
npm test           # Run all tests (Node's built-in test runner)
node --test src/modules/performance/__tests__/status.test.js  # Run a single test file
npm run test:probes      # The probes against a real Chrome, on pages with known answers (~10 s)
npm run test:discover    # The click-through behind `kanso discover`, against a real Chrome
npm run test:acceptance  # End-to-end suite against ../kanso-landing (needs Chrome, ~5 min)
```

`npm run test:probes` covers what `npm test` cannot: the code a probe runs
inside the page, which only means something against a real layout engine. The
pages in `test/probes/pages/` each break one thing on purpose, or carry every
pattern that looks like a failure and is not.

`npm test` is hermetic and fast. `npm run test:acceptance` builds the real
kanso-landing page, injects known regressions (TBT, CLS, LCP, INP, a
block too wide for a phone, a dialog that leaves focus behind it and one that
leaves the page locked — every fixture carries the dialog, declared as a
state) into the build, and asserts Kanso fails each one on
the right metric or rule while the unchanged page passes. Every step is audited
against the unchanged build as its reference, the way a change is judged against
its base. Every fixture, the baseline included, also carries one violation of
its own — an image with no alt text — so that each step has an inherited
finding to prove is not held against it; that property used to rest on the
landing page carrying violations, and stopped holding the day it was fixed. Chrome, Lighthouse and the CLI are real, and the CLI serves both
builds itself, the way the GitHub Action does — nothing is stood in. It runs
in CI through `.github/workflows/acceptance.yml`, which checks out the public
`valajan/kanso-landing` repository — no token, no secret. Set
`KANSO_ACCEPTANCE_SKIP_BUILD=1` to reuse an existing `dist/` while iterating.
`KANSO_ACCEPTANCE_STEPS=focus,residue` audits only those fixtures; CI builds
the landing page once and gives each step a job of its own. Only the steps that
judge LCP, TBT or CLS take the median of `KANSO_ACCEPTANCE_RUNS` (3); the others
settle on one load.

The GitHub Action at the repo root (`action.yml`) has its own self-test,
`.github/workflows/action.yml`: it runs the action from the checkout on the
page in `test/action/`, once passing and once under a budget no page meets —
the latter with `record: true`, checking the journal was kept though it failed.
The passing case sets its own wide timing budgets (`test/action/.kanso.yml`) and
accepts a `warn`: what it proves is the Action's plumbing, and the default
budgets of `config.yml` made it a coin toss on a contended runner.

Requires Node.js >=22.19 — Lighthouse 13's floor. No build step — all files are
run directly with Node.

## Architecture

Kanso audits a web page and judges it. **The audit is `src/core/audit.js` and
knows nothing about terminals, agents or runners**; everything else is a
surface onto it.

Three surfaces exist today:

- **the CLI** (`bin/kanso.js`) — `kanso audit <url | dir>` (and `kanso discover`,
  which writes the states the audit goes through), on a developer's
  machine, against a local build. No server, no credentials, no network but the
  page. The **GitHub Action** (`action.yml`) is this CLI run in a client's own
  runner: it writes the Markdown report to the job summary and fails the job on
  the verdict, with no token and no permission.
- **the MCP server** (`kanso mcp`) — the same audit over stdio, so the agent
  that wrote the code can measure it. Facts only: in MCP the host is the model,
  so nothing here calls one.
- **the GitHub Action** (`action.yml`) — the CLI again, in a client's own
  runner, writing the Markdown report to the job summary and exiting on the
  verdict. With `record: true` it passes `--record` and uploads the journal as
  a workflow artifact (`record-name`, by default `kanso-record-<job id>`),
  failed audit or not — outputs `record` and `record-url`.

Kanso hosts nothing and holds no credential. There is no server: the surfaces
run where the code is.

**Entry point:** `bin/kanso.js`, for the CLI and the MCP server it also starts
(`kanso mcp`). All application logic lives under `src/`.

### Module layout (`src/`)

- `config/` — `static-config.js` (config.yml), `repo-config.js` (the
  `.kanso.yml` merge), `local-config.js` (defaults + the `.kanso.yml` of the
  directory a surface runs in — the CLI and the MCP server read the same one),
  `module-config.js` (the section of it a given module reads), `merge.js`
- `probes/` — what Kanso checks on a page itself, beyond Lighthouse. A module
  declares its probes; `index.js` runs them in the audit worker, after
  Lighthouse, on the same Chrome — each in a fresh page and browser context,
  laid out as Lighthouse laid it out unless it asks for another viewport or
  media features, with a script of its own run before the page's if it needs
  one, under a timeout. A probe is handed its own module's section of the
  resolved `.kanso.yml` — the config travels with the load into the worker —
  so what it checks, and the rules it answers for, can be a matter of
  configuration. A probe that fails costs its own rules, reported as unchecked,
  never as clean. A probe marked `states: true` (axe and INP, today) also goes
  through the states `.kanso.yml` declares at its root (`src/config/states.js`
  reads them, `states.js` here reaches one: a click, then `wait_for`, then
  `settle.js` — the network quiet, then the page's finite animations
  finished, a spinner that never ends left playing, under 2 s — so that a
  panel fading in is not read half transparent), in the
  page it loaded — a tree (a state's `states:`), walked depth first: down a branch in the
  same page, each branch after the first in the page loaded again and brought
  to where it starts — and each finding made
  there carries `at`, listing only what no earlier reading found (the INP
  probe, `measures: true`, keeps every reading as it is: two clicks are two
  measures; the clicks made again on the way back are not). A state that
  cannot be reached fails, with every state reached through it, under that
  same `at`.
  A probe marked `transitions: true` checks the way into and out of each state
  rather than the state: for each, a page of its own brought to the state it
  starts from (`reach`, `states.js`), and `transition(page, state, tools)` with what
  `transition.js` hands it — open by click or by key, whether it is open (its
  `wait_for`, else the modal dialog or menu that opened, else its trigger's
  `aria-expanded`, else `null`), close by Escape or by its `close:`, where
  focus is — each move journaled, and followed by the same `settle.js`; a
  click or key that leaves the page fails the state (`the click left the page, for <where>`). A state it
  could not check costs that state; one beyond a state the way could not get
  past costs it too. `dom.js` is what a probe runs inside the page with: the call
  goes as one DevTools expression, which no page CSP can refuse, and the
  element helper describes a node the way Lighthouse does. Probes run on the
  first successful load of a page only — except a probe that measures, which
  runs on every load. `journal.js` keeps, when asked (`--record <dir>`), what
  each probe went through — loaded, each state reached or not, each finding
  with its rule, state and element paths, and what a probe logs of its own
  through the `log` it is handed (the keyboard walk's every stop) — one JSON
  Lines file per load, `<side>.<formFactor>.<run>.jsonl`, written from the
  worker however the load ends; off, it is a no-op. A view's `shot(page,
  kind, data)` logs an event with a frame — a JPEG of the viewport (quality
  60, forty a load at most) and its size in CSS pixels — kept in memory, then
  written under `frames/<journal>/`: the page loaded, each state reached, a
  transition's open and close. Never for a probe that measures
  (`withoutFrames()`), never with NO_JOURNAL
- `discover/` — what finds the states of a page, so that nobody has to write
  `states:` by hand: `kanso discover`. Outside the audit, and never called by
  it. `explore.js` clicks every element the guards allow (`guards.js`:
  read-only — no field typed in, no form sent, no other page, no button named
  like `Delete`, and a net stopping every request that writes, every
  navigation, window and dialog), each from a first visit in a context of its
  own, then every element what opened brought, breadth first, two clicks deep,
  under a click budget and a deadline. `snapshot.js` reads what a visitor can
  click, in one call inside the page — while a modal dialog is open
  (`dom.modal`, the reading `transition.js` makes: `dialog:modal`,
  `aria-modal`, or the page behind it hidden or inert), only what is inside
  it, so that two buttons opening one dialog are one state, the second click
  a `repeat` (`repeats`, and the kept state's `alsoOpenedBy`, a comment in
  the file); a modal open as the page loads narrows nothing (`markLoaded`).
  `fingerprint.js` tells a new state from
  one already seen by code — controls by role, name and ARIA state, dialogs,
  new text — less what two first visits and a scroll disagree on
  (`page.js`, `prepare`); `selectors.js` picks, for each element, the
  steadiest selector that finds it alone (test id, stable id, `::-p-aria()`,
  CSS path). A click during which the guards stopped anything — a write, a
  navigation, a window, a dialog — is never a state (`guarded`): an audit
  replays states with no guard, and would do it for real. The page's own
  beacons are not held against a click: a write to where `prepare`'s two
  first visits saw the page write with nothing clicked is noise
  (`stoppedBy`). A route changed by `pushState` has left the page (`left`).
  A click on an element a state brought that gives back the page the state
  was opened on — the same controls by role and name, whatever their ARIA
  state, none of the state's text — is how it closes (`close`, the node's
  `close`), not a state under it: a dialog's ×. Each click keeps what it
  changed (`appeared`, `disappeared`, `newText`, twenty each), and the result
  lists them all (`runs.<screen>.clicked`, in `--json`). `index.js` explores both screens side by side, then reaches each
  state again from a first visit, as an audit will (`reach`), and leaves out
  what did not come back — or came back with the guards stopping something —
  with what is reached through it; a `close` that does not click again, or
  that the guards stop, is dropped and the state kept. `states.js` makes
  the `states:` of it — one state for a path found on both screens, the others
  `form_factor:`, nested for the tree, `wait_for` and `close:` only when every
  screen that reached it agrees, names from what was clicked — and the
  whole of `.kanso/states.yml`, the file `--write` rewrites each time; the
  project's `.kanso.yml` is never touched. No model: the POC
  (`poc/jev-discovery`) showed a model adds little to finding states
- `process/` — `children.js`: the processes Kanso starts and must not leave
  behind — the servers `serve/command.js` starts, the Chromes an audit's
  workers and `discover` launch — each the leader of a process group, killed
  with it when Kanso exits or is interrupted (SIGINT, SIGTERM, SIGHUP), since
  a `finally` does not run on a signal. A worker thread receives no signal: it
  tells the main thread its Chrome's pid as soon as it is spawned
  (`whenStarted`). A headless Chrome left running is what macOS wakes in place
  of the one a person opens
- `serve/` — what the local surfaces can audit besides a URL: a directory of
  built files (`static.js`, loopback, a free port, gzip), or the command a
  project serves itself with (`command.js`, started in its own process group,
  waited for, stopped with everything it spawned). `index.js` reads a target
  named on the command line or in a tool call, reads the `serve:` block of
  `.kanso.yml`, and opens a page and its baseline for the length of one audit.
  The core only ever sees a URL
- `core/` — **the audit, with no knowledge of terminals, agents or runners.**
  `audit.js` loads a page (and optionally a baseline) on mobile + desktop, runs
  every module and returns the verdict; `levels.js` combines `pass`/`warn`/`fail`
  worst-of; `runs.js` holds how many loads a measure is worth; `target.js` is
  what every surface accepts as a page to audit; `record.js` is what a record
  directory holds, clears an earlier audit's files from it before a new one,
  and writes the result and `index.html` into it once the audit is done —
  `viewer.js`, one self-contained page (no request: it opens from file://,
  journals, result and frames inlined) listing the findings and, for the one
  selected, the moments that produced it — joined on form factor, probe,
  state, rule and element — frames with the focus boxes drawn over them;
  a finding exports from it as a page of its own, built in the browser by the
  same functions. The CLI and the MCP server are its two callers — and the
  Action is the CLI.
- `modules/` — one folder per audit concern, registered in `index.js`, which
  documents the module interface (`extract`, `combine`, `needsBaseline`,
  `evaluate`) and the two shapes of detail every surface can render — `scores`
  (measures) and `findings` (constats).
  **Adding a concern = adding a folder + one line in `index.js`.**
  `performance/` is the first: `metrics.js` is the single source of truth for
  the six metrics (labels, units, thresholds), `status.js` derives
  `pass`/`warn`/`fail` — none for a metric nobody measured —, `median.js` folds
  repeated runs, `inp.js` is the one probe that times rather than checks: INP,
  which Lighthouse cannot measure on a load, clocked on the clicks the
  declared states make, on a CPU slowed by Lighthouse's multiplier, on every
  load so that `runs:` gives it a median; with no state declared it does not
  run and INP is `null`, reported as not measured. `diagnostics.js` keeps
  what Lighthouse says about why — the LCP element and breakdown, render-blocking requests,
  layout shifts — from the load behind each median. They explain and are never
  judged. The slowest interaction — its element, state and three parts —
  joins them from `inp.js`.
  `accessibility/` is the second, and the one that proves the interface holds
  for something other than a measure: a rule is broken or it is not, so nothing
  is averaged and one load settles it. **It is also the one module that reads
  nothing from Lighthouse** — `categories: []`, everything through its own
  probes. `axe.js` injects axe-core into the page before its own scripts (so it
  reaches every frame, and no CSP can refuse it) and runs the hundred WCAG A/AA
  and best-practice rules; `accessibility: { tags: [...] }` widens or narrows
  the set. Lighthouse's own gatherer runs sixty-seven of them, from a list
  written into it where no config reaches, and throws away every result axe
  could not settle — which `axe.js` reports instead, marked `needsReview` and
  capped at `moderate`, so a contrast nobody can compute no longer reads as one
  that passed. The other four probes check what one reading of one DOM cannot:
  `reflow.js` lays the page out 320 CSS pixels wide (WCAG 1.4.10) —
  `reflow-scroll` when it scrolls sideways, `reflow-clip` when text is cut off;
  `keyboard.js` presses Tab from the top until focus leaves the page —
  `focus-trap`, `focus-visible`, `focus-obscured`; `motion.js` loads and
  scrolls through it under `prefers-reduced-motion: reduce` —
  `reduced-motion`; `focus.js`, a transition probe, opens each declared state
  from the keyboard and closes it with Escape — `keyboard-inoperable`,
  `focus-lost`, `focus-not-moved`, `focus-escapes-modal`,
  `escape-not-closing`, `focus-not-returned`, `revealed-unreachable` — reading
  what opened from the page: a modal dialog (`dialog:modal`, `aria-modal`, or
  the page behind it `aria-hidden` or inert, as component libraries make one),
  a menu or listbox, what the trigger's `aria-controls` names. `rules.js` ranks
  those thirteen rules on axe's scale; axe ranks its own. `seo/` and
  `best-practices/` are the other two Lighthouse categories, reported the same
  way. What the three share
  lives next to the registry: `findings.js` reads a category's failed rules out
  of the Lighthouse report — every failing element with its selector, tag, text
  and what is wrong with it (axe's explanation, or the columns Lighthouse shows:
  a console error's message and the line that logged it) — folds both form
  factors into one list, compares it to the baseline's and judges it — a
  finding being its rule in the state it was found in (`findingKey`: `rule`, or
  `rule@state`), so a menu is compared with the baseline's menu; `impact.js`
  is the one severity scale, axe's. What each keeps to itself is where a rule's
  impact comes from: axe gives one; for SEO and best practices, which Lighthouse
  does not rank, `rules.js` places each rule on axe's scale. SEO leaves
  `document-title` and `image-alt` to accessibility, and adds two rules of its
  own from what Lighthouse holds but does not report (`head.js`): a missing
  canonical, and the Open Graph tags a link preview needs — `extract` gets
  Lighthouse's artifacts as well as its report, for that. Best practices also
  passes through, unjudged, what Lighthouse says of the security headers
  without scoring them.
  `interactions/` is the fifth, and the first about what the page does when
  it is used: two transition probes, nothing from Lighthouse, nothing without
  a declared state. `residues.js` opens each state where the page stands and
  closes it however it closes (`closeAnyway`: Escape, its `close:`, a click
  away), then compares the page with what it was — `page-locked`,
  `overlay-left`, `page-hidden-left`, `scroll-position-lost`,
  `expanded-left`, `url-left`, `close-error`, and `scroll-not-locked` while a
  modal dialog is open; `leaks.js` opens and closes each eight times, reads
  the DOM counters after a forced garbage collection, leaves the first cycles
  out as warm-up and reports steady growth — `dom-leak`, `listener-leak`.
  Findings, judged like the other three's, its `rules.js` placing each on the
  scale
- `cli/` — the local surface. `index.js` parses the command line,
  `audit-command.js` resolves the config, serves the target and runs
  `core/audit.js`, `discover-command.js` runs `discover/` and prints or writes
  what it found, `render.js` prints the tables for a terminal and
  `markdown.js` renders the report `--out report.md` writes, under a header
  naming what was audited — which is what a CI job summary shows. The exit code
  is the verdict — 0 audited and clean,
  1 audited and over `--fail-on`, 2 the audit could not run — which is what
  makes it usable in a pre-commit hook or a CI job. `--json` prints the audit
  result and nothing else. `--record <dir>` keeps the probes' journals there,
  their frames, the result beside them as `audit.json`, and `index.html` to
  see it all
- `mcp/` — the agent surface. `index.js` wires the server and keeps stdout for
  the protocol alone, `protocol.js` is the JSON-RPC stdio transport (written out
  rather than depended on: the reference SDK drags express, hono, jose and ajv
  in for transports Kanso does not serve), `tools.js` exposes `audit_page` and
  `list_modules`. The result is the JSON of `kanso audit --json`, in both the
  text and the structured block, with nothing sampled out — an agent handed
  part of a finding reloads the page for the rest; a long call reports
  progress, which is what keeps a host from abandoning it. With `screenshot:
  true`, the page under audit as its load ended follows as image blocks, one
  per form factor — `audit({ screenshots })` in the core, carried by the
  runner under the `SCREENSHOT` symbol, never in the JSON. With `record:
  <dir>` (relative to the directory the server was started in), the journals
  are kept there as with `--record`, the result beside them as `audit.json`,
  and the result says where under `record`
- `lighthouse/runner.js` — runs the page loads; `runner.worker.js` is one load
  in its own worker thread, collecting the union of the modules' Lighthouse
  categories and handing each module the report to `extract` from

At the repo root, `kanso-action.example.yml` is what a client repo copies: the
workflow that builds the pull request and its base branch and hands both
directories to `action.yml`.

### Main flow

1. A surface resolves what to audit: a URL, a directory it serves itself, or the
   command `serve:` names — `src/serve/`.
2. Four Lighthouse audits run in parallel — mobile + desktop × page + reference
   — each in its own worker thread. Worker isolation is what allows
   parallelism: Lighthouse (via marky) writes to Node's `performance` namespace,
   and audits sharing a thread corrupt each other's marks. Set `runs` above 1 to
   report the per-metric median of several runs instead of a single noisy one.
3. Each module judges its results. For performance, metrics (score, LCP, TBT,
   CLS, FCP) are compared against per-repo budgets; status is `pass` / `warn` /
   `fail`, worst-of across form factors, and worst-of across modules. For
   accessibility, SEO and best practices, each broken rule is judged on its
   impact — and, when a reference page was loaded, on whether that page already
   broke it: with a reference Kanso judges what the change did, without one it
   judges the page as it stands.

   Steps 2 and 3 are `src/core/audit.js`. Everything before and after is the
   surface: the terminal render (`cli/render.js`), the Markdown report
   (`cli/markdown.js`), or the MCP payload (`mcp/tools.js`).
4. The verdict becomes an exit code — 0 pass, 1 over the `--fail-on` threshold,
   2 the audit could not run — which is what fails a CI job.

## Configuration

`config.yml` is the static base config. A repo overrides it with `.kanso.yml`,
deep-merged key by key (partial overrides allowed at any depth). **Each module
reads the section carrying its id** (`accessibility: { fail_on: serious }`) and
never sees the rest of the file, so two concerns cannot fight over a key name —
`src/config/module-config.js`. The four findings sections take the same keys:
`fail_on` (an impact) and `ignore` (rule ids left unjudged — the `noindex`
preview hosts add is what it is for). Performance's `budgets:` predate the sections and
still work at the root, which is where every `.kanso.yml` written so far keeps
them; a `performance:` section wins over them, budget by budget. `runs:` stays
at the root on purpose: it counts page loads, and one load feeds every module.

The CLI reads that same `.kanso.yml` from the working directory (or `--config
<path>`), so a developer's local run and the CI's run judge a page by the same
numbers; the MCP server reads it from the directory its host started it in, so
an agent's audit is judged by them too. Config controls budgets, each module's
own thresholds and `runs`.

`states:`, at the root like `runs:`, lists the states of the page beyond the
one it loads in — `name`, `click`, optional `form_factor` (`mobile` or
`desktop`: a state one screen only has), optional `wait_for`, optional `close`
(what closes it when Escape does not — Escape is always tried first, so a
`close:` never spares a dialog its `escape-not-closing`), and optional `states:`, the
states reached from it, which inherit its form factor — which a check can go
through; a malformed one fails the config as it loads (`local-config.js`).
They come from two files: `.kanso/states.yml`, which `kanso discover --write`
rewrites whole, and the project's own `.kanso.yml`, for what a click-through
cannot find. `loadLocalConfig` reads both (`statesFile` says where the first
is: beside the configuration), and `combineStates` makes one flat list of them
— `from` for the nesting, each found state marked `generated` — the project's
entry winning where both reach a state by the same clicks, and what was found
under it reached from the project's.

`serve:` says how to serve the project when a local surface is given no page:
`dir:` (a build directory, served by Kanso) or `command:` + `url:` (what serves
it, and where), relative to the file. The CLI, the MCP server and the Action
all read it.

**Environment:** one variable, `LIGHTHOUSE_CONCURRENCY` (default 3,
`src/lighthouse/runner.js`) — how many headless Chromes may run at once, each
~300-400 MB. Nothing else is read from the environment: no key, no token, no
endpoint.
