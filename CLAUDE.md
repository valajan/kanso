# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start the server
npm run dev        # Start with --watch for auto-reload on file changes
npm test           # Run all tests (Node 20+ built-in test runner)
node --test src/metrics/__tests__/status.test.js  # Run a single test file
```

Requires Node.js >=20. No build step — all files are run directly with Node.

## Architecture

Kanso is a GitHub App that automatically audits web performance on pull requests and posts results as GitHub comments.

**Entry point:** `server.js` — a thin bootstrap that loads config, wires dependencies, and starts the server. All application logic lives under `src/`.

**Module layout (`src/`):**

- `app.js` — Fastify factory: logger, raw-body JSON parser, `/health` and `/webhook` routes
- `config/` — `env.js` (env validation), `static-config.js` (config.yml), `repo-config.js` (`.kanso.yml` merge)
- `metrics/` — `registry.js` is the single source of truth for the five metrics (labels, units, thresholds); `status.js` derives `pass`/`warn`/`fail`
- `webhook/` — `signature.js` (HMAC verify), `router.js` (event aiguillage), `provider-dispatcher.js`, `pull-request-handler.js`
- `providers/` — one module per preview host (Netlify, Vercel/Render, Cloudflare, Amplify, Railway), registered in `index.js`. Each exposes `resolve(payload, ctx)` and reacts to one webhook event. **Adding a host = adding a module + one line in `index.js`.**
- `pipeline/` — `state.js` (`PreviewStore`, the in-memory webhook coordination state) and `orchestrator.js` (the audit-and-report pipeline)
- `report/` — `comment.js` (PR comment) and `commit-status.js` (GitHub commit status)
- `lighthouse/runner.js` — runs a single Lighthouse audit

**Main flow:**

1. A webhook fires on `pull_request` (opened/reopened/synchronize) or a preview-provider event (`status`, `deployment_status`, `check_run`, `issue_comment`)
2. `PreviewStore` coordinates async state between the PR lifecycle and the preview-ready events
3. `lighthouse/runner.js` runs sequential Lighthouse audits on the PR preview URL and a production reference URL — sequential because parallel runs corrupt Node's `performance` namespace
4. Metrics (score, LCP, TBT, CLS, FCP) are compared against per-repo budgets; status is `pass` / `warn` / `fail`
5. Results post to GitHub as a PR comment (badge + table)
6. If any metric regresses >10% and `ai_analysis: true`, the `src/ai-analysis/` module runs

**AI analysis module (`src/ai-analysis/`):**

- `index.js` — orchestrator; takes the `gptClient` injected from `server.js`
- `gpt-client.js` — `createGptClient(env.ai)` factory; returns `null` when no API key is set, which disables the analysis pipeline-wide
- `diff-fetcher.js` — fetches relevant GitHub diffs (skips lockfiles, tests, etc.)
- `prompt-builder.js` — builds structured OpenAI prompts with metric context and diff
- `validator.js` — validates and sanitizes LLM JSON output
- `report-formatter.js` — formats results as inline GitHub review comments

**Configuration:** `config.yml` is the static base config. Repos can override with a `.kanso.yml` in the repo root, which is merged per-metric (partial overrides are allowed). Config controls budgets, reference URLs, and whether AI analysis is enabled.

**Environment variables** (see `.env.example`, validated in `src/config/env.js`):

- Required: `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and one of `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_PATH`
- Optional: `PORT` (3000), `LIGHTHOUSE_CONCURRENCY` (3)
- AI analysis, all optional: `OPENAI_API_KEY` (unset ⇒ analysis disabled), `OPENAI_BASE_URL` (any OpenAI-compatible endpoint: OpenRouter, Groq, Ollama…), `KANSO_AI_MODEL`, `KANSO_AI_MAX_TOKENS`, `KANSO_AI_TIMEOUT_MS`, `KANSO_AI_MAX_RETRIES`

Provider settings live in the environment rather than `config.yml` on purpose: `config.yml` keys are overridable by each client repo's `.kanso.yml`, and the model/token budget spend the operator's own API credits. The credential and endpoint keep the ecosystem-standard `OPENAI_*` names — in the OpenAI-compatible ecosystem they denote the protocol, not the vendor — while Kanso's own knobs are prefixed `KANSO_AI_`.
