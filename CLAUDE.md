# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bin/kanso.js audit <url>  # Audit a page from the terminal (npm run kanso -- audit <url>)
npm start          # Start the server
npm run dev        # Start with --watch for auto-reload on file changes
npm test           # Run all tests (Node 20+ built-in test runner)
node --test src/modules/performance/__tests__/status.test.js  # Run a single test file
npm run test:acceptance  # End-to-end suite against ../kanso-frontend (needs Chrome, ~5 min)
```

`npm test` is hermetic and fast. `npm run test:acceptance` builds the real
kanso-frontend landing page, injects known regressions (TBT, CLS, LCP) into the
build, and asserts Kanso fails each one on the right metric while the unchanged
page passes. Every push is audited against the unchanged build as its reference,
the way a PR is judged against its base — which is also what proves the axe
findings that page already carries are reported without failing a push that did
not add them. Chrome, Lighthouse, the Kanso server and the CI client are real;
GitHub is faked (`test/acceptance/fake-github.mjs`), so no PR is touched. It runs
in CI through `.github/workflows/acceptance.yml`, which needs the
`FRONTEND_REPO_TOKEN` secret to check out the private frontend repo. Set
`KANSO_ACCEPTANCE_SKIP_BUILD=1` to reuse an existing `dist/` while iterating.

Requires Node.js >=20. No build step — all files are run directly with Node.

## Architecture

Kanso audits a web page and judges it. **The audit is `src/core/audit.js` and
knows nothing about pull requests, forges or servers**; everything else is a
surface onto it.

Two surfaces exist today:

- **the CLI** (`bin/kanso.js`) — `kanso audit <url>`, on a developer's machine,
  against a local build. No server, no credentials, no network but the page.
- **the PR report**, with **two triggers into one pipeline**:
  1. **`POST /v1/audit`** — a CI job posts the preview URL it just deployed.
     Platform-agnostic, stateless, and the preferred path.
  2. **`POST /webhook`** — the GitHub App, which works the preview URL out from
     a preview host's webhook events. GitHub-only, and needs cross-request state.

  Both converge on the same orchestrator and the same report.

**Entry points:** `server.js` — a thin bootstrap that loads config, wires
dependencies, and starts the server — and `bin/kanso.js` for the CLI. All
application logic lives under `src/`.

### Module layout (`src/`)

- `app.js` — Fastify factory: logger, raw-body JSON parser, body limit, and the
  `/health`, `/webhook` and `/v1/audit` routes
- `config/` — `env.js` (env validation), `static-config.js` (config.yml),
  `repo-config.js` (`.kanso.yml` merge, from the forge or supplied inline),
  `module-config.js` (the section of it a given module reads), `merge.js`
- `forge/` — **the only place that knows what platform we are talking to.**
  `index.js` documents the interface and registers adapters; `github.js`
  implements it. Nothing else in the codebase calls `octokit`.
- `security/` — `url-guard.js` (SSRF), `rate-limit.js` (token bucket)
- `core/` — **the audit, with no knowledge of PRs, forges or servers.**
  `audit.js` loads a page (and optionally a baseline) on mobile + desktop, runs
  every module and returns the verdict; `levels.js` combines `pass`/`warn`/`fail`
  worst-of; `runs.js` holds how many loads a measure is worth. The CLI and the
  PR report are two callers; an MCP server will be a third.
- `modules/` — one folder per audit concern, registered in `index.js`, which
  documents the module interface (`extract`, `combine`, `needsBaseline`,
  `evaluate`) and the two shapes of detail every surface can render — `scores`
  (measures) and `findings` (constats).
  **Adding a concern = adding a folder + one line in `index.js`.**
  `performance/` is the first: `metrics.js` is the single source of truth for
  the five metrics (labels, units, thresholds), `status.js` derives
  `pass`/`warn`/`fail`, `median.js` folds repeated runs, `regressions.js` picks
  the failures worth an AI analysis.
  `accessibility/` is the second, and the one that proves the interface holds
  for something other than a measure: `findings.js` reads the failed axe rules
  out of the Lighthouse report, folds both form factors into one list and
  compares it to the baseline's; `impact.js` is the severity scale. A rule is
  broken or it is not, so nothing is averaged and one load settles it
- `cli/` — the local surface. `index.js` parses the command line,
  `audit-command.js` resolves the config and runs `core/audit.js`, `render.js`
  prints the tables. It never loads `config/env.js`: that validates GitHub App
  credentials a developer auditing localhost does not have. The exit code is
  the verdict — 0 audited and clean, 1 audited and over `--fail-on`, 2 the
  audit could not run — which is what makes it usable in a pre-commit hook or a
  CI job. `--json` prints the audit result and nothing else
- `api/` — `validate.js` (request validation), `audit-route.js` (`/v1/audit`)
- `webhook/` — `signature.js` (HMAC verify), `router.js` (event aiguillage),
  `provider-dispatcher.js`, `pull-request-handler.js`
- `providers/` — one module per preview host (Netlify, Vercel/Render,
  Cloudflare, Amplify, Railway), registered in `index.js`. Each exposes
  `resolve(payload, ctx)` and reacts to one webhook event. **Adding a host =
  adding a module + one line in `index.js`.** Only the webhook trigger uses
  these — the API trigger is told the URL.
- `pipeline/` — `jobs.js` (bounded background queue), `state.js` (`PreviewStore`,
  webhook-only coordination state), `orchestrator.js` (`core/audit.js`, then
  report on the PR)
- `report/` — `comment.js` (PR comment + `REPORT_MARKER`), `commit-status.js`
- `lighthouse/runner.js` — runs the page loads; `runner.worker.js` is one load
  in its own worker thread, collecting the union of the modules' Lighthouse
  categories and handing each module the report to `extract` from

At the repo root, `integrations/` is what client repos run, not part of the
server: the CI client (`kanso-audit.mjs`, zero dependencies), a GitHub composite
action wrapping it, and example GitHub and GitLab pipelines.

### Main flow

1. A trigger fires: a CI job POSTs to `/v1/audit`, or a webhook arrives.
2. The request is authorized, validated, and handed to the job queue; the
   caller gets an answer immediately.
3. Four Lighthouse audits run in parallel — mobile + desktop × preview +
   reference — each in its own worker thread. Worker isolation is what allows
   parallelism: Lighthouse (via marky) writes to Node's `performance` namespace,
   and audits sharing a thread corrupt each other's marks. Set `runs` above 1 to
   report the per-metric median of several runs instead of a single noisy one.
   Steps 3 and 4 are `src/core/audit.js`; the rest is the PR surface.
4. Each module judges its results. For performance, metrics (score, LCP, TBT,
   CLS, FCP) are compared against per-repo budgets; status is `pass` / `warn` /
   `fail`, worst-of across form factors, and worst-of across modules. For
   accessibility, each broken axe rule is judged on its impact — and, when a
   reference page was loaded, on whether that page already broke it: with a
   reference Kanso judges what the change did, without one it judges the page
   as it stands.
5. Results post as a PR comment (badge + one table per form factor + one
   section per module reporting findings) and a commit status. The comment
   carries a hidden `REPORT_MARKER`, so a re-run finds and edits it rather than
   stacking a new one.
6. If any metric regresses >10% and `ai_analysis: true`, `src/ai-analysis/` runs
   detached — the verdict is already final without it.

### The forge boundary

Every read and write on a PR goes through a forge adapter, bound to one repo and
carrying its own credentials. Two call sites build one:

- the webhook path, from a GitHub App installation token
- `/v1/audit`, from **the caller's own CI token**

The interface is 9 methods (`getPullRequest`, `findComment`, `postComment`,
`editComment`, `setStatus`, `getPullRequestFiles`, `postReview`,
`getFileContent`, plus the webhook-only `findOpenPullRequestForSha`). Supporting
GitLab or Bitbucket means writing one adapter, not touching the pipeline.

Adapters normalize errors: a missing resource resolves to `null`, so callers
never branch on HTTP status codes. A 403 is only folded into `null` where "can't
see it" and "not there" deserve the same handling — an optional config file, a
comment scan. Elsewhere it propagates, so a mis-scoped token is reported as a
permission problem rather than a missing PR.

### Security model of `/v1/audit`

The endpoint is public, so three things carry it:

**Authorization is a write probe.** Kanso posts the placeholder comment *with
the caller's token*, before scheduling any audit. A successful write proves the
caller has comment access to the PR they named; a failure is a 403. There is no
shared secret to distribute, no per-repo credential store, and no privilege for
a confused-deputy attack to borrow — Kanso only ever acts with the caller's own
token on the caller's own repo. It also means no CPU is spent before the caller
is authorized.

**Nothing the caller writes reaches the report.** Branch names, the head SHA and
the PR state are re-read from the forge. The only caller-supplied value rendered
into the comment is the preview URL, and `source`, which is constrained to a
conservative character class.

**Every URL is vetted before Chrome loads it** (`src/security/url-guard.js`).
Without this the endpoint is an SSRF primitive: a caller could point Kanso at
`http://169.254.169.254/` and read the cloud metadata service back out of the
Lighthouse report rendered into their own PR. The guard resolves the hostname
and refuses unless every address is publicly routable — including v4-mapped and
NAT64 forms, which is where a naive IPv6 check leaks. Chrome resolves the name
again when it loads the page, so DNS rebinding remains possible in principle;
the guard re-checks immediately before the audit, and
`KANSO_ALLOWED_PREVIEW_HOSTS` closes it completely for deployments that need it.

The CLI deliberately skips the guard. It exists because `/v1/audit` is a public
endpoint that must not be aimed at private addresses on the operator's behalf;
on a developer's own machine, `http://localhost:4173` is the whole point.

### Capacity

Audits are minutes long, so neither trigger holds a request open for one: both
enqueue into `src/pipeline/jobs.js` and answer immediately (202 for the API,
which also fixes the webhook deliveries GitHub was abandoning at its 10-second
timeout). The queue is bounded in both concurrency and depth — past that the API
returns 429 rather than growing a backlog that times every caller out. A
per-repo token bucket is the first gate, evaluated before any network call.

`GET /v1/audit/:id` returns the verdict, which is what lets a CI job fail its
build on a regression — something the webhook trigger cannot offer, because
nothing in the CI knows an audit is happening.

### AI analysis module (`src/ai-analysis/`)

- `index.js` — orchestrator; takes the `gptClient` injected from `server.js`
- `gpt-client.js` — `createGptClient(env.ai)` factory; returns `null` when no API
  key is set, which disables the analysis pipeline-wide
- `diff-fetcher.js` — fetches relevant diffs through the forge (skips lockfiles,
  tests, etc.)
- `prompt-builder.js` — builds structured OpenAI prompts with metric context and diff
- `validator.js` — validates and sanitizes LLM JSON output
- `report-formatter.js` — formats results as inline review comments

## Configuration

`config.yml` is the static base config. A repo overrides it with `.kanso.yml`,
deep-merged key by key (partial overrides allowed at any depth). **Each module
reads the section carrying its id** (`accessibility: { fail_on: serious }`) and
never sees the rest of the file, so two concerns cannot fight over a key name —
`src/config/module-config.js`. Performance's `budgets:` predate the sections and
still work at the root, which is where every `.kanso.yml` written so far keeps
them; a `performance:` section wins over them, budget by budget. `runs:` stays
at the root on purpose: it counts page loads, and one load feeds every module.

The CLI reads that same `.kanso.yml` from the working directory (or `--config
<path>`), so a developer's local run and the CI's run judge a page by the same
numbers. On the API path the CI sends that file's contents inline — one fewer
API call, and it works with a token that has no contents scope. Config controls
budgets, each module's own thresholds, the reference URL, `runs`, and whether AI
analysis is enabled.

**Environment variables** (see `.env.example`, validated in `src/config/env.js`):

- Required: `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and one of
  `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_PATH`
- Optional: `PORT` (3000), `LIGHTHOUSE_CONCURRENCY` (3)
- Capacity: `KANSO_JOB_CONCURRENCY` (2), `KANSO_MAX_QUEUED` (20),
  `KANSO_RATE_LIMIT_PER_MINUTE` (10)
- Security: `KANSO_ALLOWED_PREVIEW_HOSTS` (unset ⇒ any public address),
  `KANSO_GITHUB_API_URL` (GitHub Enterprise Server)
- AI analysis, all optional: `OPENAI_API_KEY` (unset ⇒ analysis disabled),
  `OPENAI_BASE_URL` (any OpenAI-compatible endpoint: OpenRouter, Groq, Ollama…),
  `KANSO_AI_MODEL`, `KANSO_AI_MAX_TOKENS`, `KANSO_AI_TIMEOUT_MS`,
  `KANSO_AI_MAX_RETRIES`

Provider settings live in the environment rather than `config.yml` on purpose:
`config.yml` keys are overridable by each client repo's `.kanso.yml`, and the
model/token budget spend the operator's own API credits. The credential and
endpoint keep the ecosystem-standard `OPENAI_*` names — in the OpenAI-compatible
ecosystem they denote the protocol, not the vendor — while Kanso's own knobs are
prefixed `KANSO_AI_`.
