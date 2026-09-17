# Kanso CI integrations

Kanso has two triggers. This directory covers the second one.

| | GitHub App webhook | CI trigger (`POST /v1/audit`) |
|---|---|---|
| How the preview URL is found | reverse-engineered from the host's webhooks | the CI job passes it |
| Hosts supported | the five with a provider module | any — the CI already knows the URL |
| Platforms | GitHub only | GitHub, GitLab, Bitbucket, anything with a token |
| Survives multiple instances | no — coordination state is per-process | yes — one request carries everything |
| Can fail the build | no | yes, on the returned verdict |
| Setup | install the App | ~10 lines of CI YAML |

## The client

`kanso-audit.mjs` is the whole integration: one file, no dependencies, Node 18+.
It posts the preview URL, waits for the verdict, and exits non-zero when the
audit fails. `node kanso-audit.mjs --help` lists every flag.

```bash
node integrations/kanso-audit.mjs \
  --api https://kanso.example.com \
  --token "$GITHUB_TOKEN" \
  --repo acme/site \
  --pr 42 \
  --sha "$GITHUB_SHA" \
  --preview-url https://pr-42.netlify.app
```

On GitHub Actions and GitLab CI, `--repo`, `--pr` and `--sha` are read from the
environment, so `--preview-url` is usually the only flag you need.

## Permissions

Kanso posts the report **with the token you give it** — it holds no credential
of its own for your repository. That token is also how authorization works: the
placeholder comment is written before any audit is scheduled, and a caller who
cannot write that comment gets a 403 and no audit.

So the token needs exactly what the report writes, and nothing more:

- **GitHub Actions** — `permissions: { pull-requests: write, statuses: write }`
  on the job. The built-in `GITHUB_TOKEN` then works; no PAT, no App install.
- **GitLab** — a project access token with the `api` scope. `CI_JOB_TOKEN`
  cannot write merge request notes.

## Two things worth configuring

**Compare against the base branch's preview, not production.** `--base-url`
defaults to whatever `.kanso.yml` sets, which is usually the production site.
Production and a preview differ in CDN, cache warmth and build flags, so part of
every delta you see is hosting rather than code. If your host builds a preview
for the base branch, point `--base-url` at that instead and the comparison
isolates the change under review.

**Take the median of several runs.** A single Lighthouse run swings by 20-30% on
TBT. Set `runs: 3` in `.kanso.yml` so a noisy run cannot fail a good PR — or
trigger an AI analysis of a regression that was never there.

## Files

- `kanso-audit.mjs` — the client
- `github-action/action.yml` — composite action wrapping it
- `github-workflow.example.yml` — full workflow, deploy + audit
- `gitlab-ci.example.yml` — the same, on GitLab
