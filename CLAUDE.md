# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start the server
npm run dev        # Start with --watch for auto-reload on file changes
npm test           # Run all tests (Node 20+ built-in test runner)
node --test src/ai-analysis/__tests__/validator.test.js  # Run a single test file
```

Requires Node.js >=20. No build step — all files are run directly with Node.

## Architecture

PerfGuard is a GitHub App that automatically audits web performance on pull requests and posts results as GitHub comments.

**Entry point:** `server.js` — Fastify HTTP server receiving GitHub webhooks at `POST /webhook`. Signature-verified with HMAC-SHA256.

**Main flow:**
1. Webhook fires on `pull_request` (opened/synchronize) or `deployment_status` (Netlify/Vercel preview ready)
2. In-memory maps (`previewUrls`, `pendingPRs`, `waitingComments`) coordinate async state between these two event streams
3. `lighthouse.js` runs sequential Lighthouse audits on the PR preview URL and a production reference URL — sequential because parallel runs corrupt Node's `performance` namespace
4. Metrics (score, LCP, TBT, CLS, FCP) are compared against per-repo budgets; status is `pass` / `warn` / `fail`
5. Results post to GitHub as a PR comment (badge + table)
6. If any metric regresses >10% and `ai_analysis: true`, the `src/ai-analysis/` module runs

**AI analysis module (`src/ai-analysis/`):**
- `index.js` — orchestrator
- `diff-fetcher.js` — fetches relevant GitHub diffs (skips lockfiles, tests, etc.)
- `prompt-builder.js` — builds structured OpenAI prompts with metric context and diff
- `validator.js` — validates and sanitizes LLM JSON output
- `report-formatter.js` — formats results as inline GitHub review comments

**Configuration:** `config.yml` is the static base config. Repos can override with a `.perfguard.yml` in the repo root, which is merged per-metric (partial overrides are allowed). Config controls budgets, reference URLs, and whether AI analysis is enabled.

**Required environment variables** (see `.env.example`): `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY_PATH`, `OPENAI_API_KEY`, `PORT`.
