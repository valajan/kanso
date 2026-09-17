# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start the server
npm run dev        # Start with --watch for auto-reload on file changes
npm test           # Run all tests (Node 20+ built-in test runner)
node --test src/metrics/__tests__/status.test.js  # Run a single test file
npm run test:acceptance  # End-to-end suite against ../kanso-frontend (needs Chrome, ~5 min)
```

`npm test` is hermetic and fast. `npm run test:acceptance` builds the real
kanso-frontend landing page, injects known regressions (TBT, CLS, LCP) into the
build, and asserts Kanso fails each one on the right metric while the unchanged
page passes. Chrome, Lighthouse, the Kanso server and the CI client are real;
GitHub is faked (`test/acceptance/fake-github.mjs`), so no PR is touched. It runs
in CI through `.github/workflows/acceptance.yml`, which needs the
`FRONTEND_REPO_TOKEN` secret to check out the private frontend repo. Set
`KANSO_ACCEPTANCE_SKIP_BUILD=1` to reuse an existing `dist/` while iterating.

Requires Node.js >=20. No build step — all files are run directly with Node.

## Architecture

Kanso audits web performance on pull requests and posts the results back to the
PR. It has **two triggers into one pipeline**:

1. **`POST /v1/audit`** — a CI job posts the preview URL it just deployed.
   Platform-agnostic, stateless, and the preferred path.
2. **`POST /webhook`** — the GitHub App, which works the preview URL out from a
   preview host's webhook events. GitHub-only, and needs cross-request state.

Both converge on the same orchestrator and the same report.

**Entry point:** `server.js` — a thin bootstrap that loads config, wires
dependencies, and starts the server. All application logic lives under `src/`.

### Module layout (`src/`)

- `app.js` — Fastify factory: logger, raw-body JSON parser, body limit, and the
  `/health`, `/webhook` and `/v1/audit` routes
- `config/` — `env.js` (env validation), `static-config.js` (config.yml),
  `repo-config.js` (`.kanso.yml` merge, from the forge or supplied inline)
- `forge/` — **the only place that knows what platform we are talking to.**
  `index.js` documents the interface and registers adapters; `github.js`
  implements it. Nothing else in the codebase calls `octokit`.
- `security/` — `url-guard.js` (SSRF), `rate-limit.js` (token bucket)
- `metrics/` — `registry.js` is the single source of truth for the five metrics
  (labels, units, thresholds); `status.js` derives `pass`/`warn`/`fail`
- `api/` — `validate.js` (request validation), `audit-route.js` (`/v1/audit`)
- `webhook/` — `signature.js` (HMAC verify), `router.js` (event aiguillage),
  `provider-dispatcher.js`, `pull-request-handler.js`
- `providers/` — one module per preview host (Netlify, Vercel/Render,
  Cloudflare, Amplify, Railway), registered in `index.js`. Each exposes
  `resolve(payload, ctx)` and reacts to one webhook event. **Adding a host =
  adding a module + one line in `index.js`.** Only the webhook trigger uses
  these — the API trigger is told the URL.
- `pipeline/` — `jobs.js` (bounded background queue), `state.js` (`PreviewStore`,
  webhook-only coordination state), `orchestrator.js` (audit-and-report)
- `report/` — `comment.js` (PR comment + `REPORT_MARKER`), `commit-status.js`
- `lighthouse/runner.js` — runs the audits; `runner.worker.js` is one audit in
  its own worker thread
- `integrations/` — the CI client (`kanso-audit.mjs`, zero dependencies) plus a
  GitHub composite action and a GitLab snippet

### Main flow

1. A trigger fires: a CI job POSTs to `/v1/audit`, or a webhook arrives.
2. The request is authorized, validated, and handed to the job queue; the
   caller gets an answer immediately.
3. Four Lighthouse audits run in parallel — mobile + desktop × preview +
   reference — each in its own worker thread. Worker isolation is what allows
   parallelism: Lighthouse (via marky) writes to Node's `performance` namespace,
   and audits sharing a thread corrupt each other's marks. Set `runs` above 1 to
   report the per-metric median of several runs instead of a single noisy one.
4. Metrics (score, LCP, TBT, CLS, FCP) are compared against per-repo budgets;
   status is `pass` / `warn` / `fail`, worst-of across form factors.
5. Results post as a PR comment (badge + one table per form factor) and a commit
   status. The comment carries a hidden `REPORT_MARKER`, so a re-run finds and
   edits it rather than stacking a new one.
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
merged per-metric (partial overrides allowed). On the API path the CI sends that
file's contents inline — one fewer API call, and it works with a token that has
no contents scope. Config controls budgets, the reference URL, `runs`, and
whether AI analysis is enabled.

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
