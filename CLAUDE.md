# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/kanso.js audit <url>  # Audit a page from the terminal (npm run kanso -- audit <url>)
node bin/kanso.js audit dist   # Audit a build directory, served by Kanso for the audit
node bin/kanso.js mcp          # Serve the audit to a coding agent over MCP (stdio)
npm test           # Run all tests (Node's built-in test runner)
node --test src/modules/performance/__tests__/status.test.js  # Run a single test file
npm run test:probes      # The probes against a real Chrome, on pages with known answers (~10 s)
npm run test:acceptance  # End-to-end suite against ../kanso-frontend (needs Chrome, ~5 min)
```

`npm run test:probes` covers what `npm test` cannot: the code a probe runs
inside the page, which only means something against a real layout engine. The
pages in `test/probes/pages/` each break one thing on purpose, or carry every
pattern that looks like a failure and is not.

`npm test` is hermetic and fast. `npm run test:acceptance` builds the real
kanso-frontend landing page, injects known regressions (TBT, CLS, LCP, and a
block too wide for a phone) into the build, and asserts Kanso fails each one on
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

The GitHub Action at the repo root (`action.yml`) has its own self-test,
`.github/workflows/action.yml`: it runs the action from the checkout on the
page in `test/action/`, once passing and once under a budget no page meets.
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

- **the CLI** (`bin/kanso.js`) — `kanso audit <url | dir>`, on a developer's
  machine, against a local build. No server, no credentials, no network but the
  page. The **GitHub Action** (`action.yml`) is this CLI run in a client's own
  runner: it writes the Markdown report to the job summary and fails the job on
  the verdict, with no token and no permission.
- **the MCP server** (`kanso mcp`) — the same audit over stdio, so the agent
  that wrote the code can measure it. Facts only: in MCP the host is the model,
  so nothing here calls one.
- **the GitHub Action** (`action.yml`) — the CLI again, in a client's own
  runner, writing the Markdown report to the job summary and exiting on the
  verdict.

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
  reads them, `states.js` here reaches one: a click, then `wait_for`), in the
  page it loaded — cumulative, no load of their own — and each finding made
  there carries `at`, listing only what no earlier reading found (the INP
  probe, `measures: true`, keeps every reading as it is: two clicks are two
  measures). A state that
  cannot be reached fails, with every state after it, under that same `at`. `dom.js` is what a probe runs inside the page with: the call
  goes as one DevTools expression, which no page CSP can refuse, and the
  element helper describes a node the way Lighthouse does. Probes run on the
  first successful load of a page only — except a probe that measures, which
  runs on every load
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
  what every surface accepts as a page to audit. The CLI and the MCP server are
  its two callers — and the Action is the CLI.
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
  that passed. The other three probes check what one reading of one DOM cannot:
  `reflow.js` lays the page out 320 CSS pixels wide (WCAG 1.4.10) —
  `reflow-scroll` when it scrolls sideways, `reflow-clip` when text is cut off;
  `keyboard.js` presses Tab from the top until focus leaves the page —
  `focus-trap`, `focus-visible`, `focus-obscured`; `motion.js` loads and
  scrolls through it under `prefers-reduced-motion: reduce` —
  `reduced-motion`. `rules.js` ranks those six rules on axe's scale; axe ranks
  its own. `seo/` and
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
  without scoring them
- `cli/` — the local surface. `index.js` parses the command line,
  `audit-command.js` resolves the config, serves the target and runs
  `core/audit.js`, `render.js` prints the tables for a terminal and
  `markdown.js` renders the report `--out report.md` writes, under a header
  naming what was audited — which is what a CI job summary shows. The exit code
  is the verdict — 0 audited and clean,
  1 audited and over `--fail-on`, 2 the audit could not run — which is what
  makes it usable in a pre-commit hook or a CI job. `--json` prints the audit
  result and nothing else
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
  runner under the `SCREENSHOT` symbol, never in the JSON
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
`src/config/module-config.js`. The three findings sections take the same keys:
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
one it loads in — `name`, `click`, optional `wait_for` — which a check can go
through; a malformed one fails the config as it loads (`local-config.js`).

`serve:` says how to serve the project when a local surface is given no page:
`dir:` (a build directory, served by Kanso) or `command:` + `url:` (what serves
it, and where), relative to the file. The CLI, the MCP server and the Action
all read it.

**Environment:** one variable, `LIGHTHOUSE_CONCURRENCY` (default 3,
`src/lighthouse/runner.js`) — how many headless Chromes may run at once, each
~300-400 MB. Nothing else is read from the environment: no key, no token, no
endpoint.
