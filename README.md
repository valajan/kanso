# Kanso

Kanso loads a page in Chrome, measures what it costs, checks what it breaks, and
returns a verdict: `pass`, `warn` or `fail`. Performance, accessibility, SEO and
best practices today, in a single page load; on mobile **and** desktop; against
your own thresholds — and it can judge one version of a page against another.

Four ways to run it, from the simplest to the most integrated: **locally**
while you work, **from your coding agent** so it can measure what it just wrote,
**in CI** to stop a regression, **on a pull request** so the measurement lands in
the review.

---

## 1. Requirements

- **Node 22.19 or later** (`node -v`) — Lighthouse 13's floor
- **Google Chrome** installed — Kanso drives it, it does not ship it

Nothing else: no account, no API key, no server.

## 2. Install the command

From the Kanso checkout, once:

```bash
npm install
npm link          # puts `kanso` on your PATH
```

Check it:

```bash
kanso --help
```

> Without `npm link`, the command is `node /path/to/kanso/bin/kanso.js`.

## 3. Audit a page

Build your project, then point Kanso at what the build wrote:

```bash
# in your web project
npm run build
kanso audit dist
```

Kanso serves the directory itself — on a free port, gzipped like a CDN would,
for the length of the audit — so there is nothing to start and nothing left
running. It also audits **a URL**, wherever it comes from: a preview server, a
container, a deployment.

```bash
kanso audit http://localhost:3000
```

```
Kanso · dist
against the configured budgets · mobile + desktop · 1 run per page · 9s

Performance  pass

mobile
               budget  current        Δ
  Performance      49       99      +50  pass
  LCP          4000ms   2121ms  -1879ms  pass
  TBT           600ms      0ms   -600ms  pass
  CLS            0.25     0.00    -0.25  pass
  FCP          3000ms   1371ms  -1629ms  pass

desktop
  …

Accessibility  fail

  image-alt          critical  1 element   fail
      Element does not have an alt attribute; aria-label attribute does not exist or is empty; …
      body > img.logo
  color-contrast     serious   2 elements  fail
      main > p.note  "Prices exclude tax"
        Element has insufficient color contrast of 2.84 (foreground color: #999999, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1
      footer > small  "© 2026 Acme"
        Element has insufficient color contrast of 2.84 (foreground color: #999999, background color: #ffffff, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1
  landmark-one-main  moderate  1 element   warn
      Document does not have a main landmark
      html

  failing from serious up

SEO  pass

  no findings

  failing from serious up

Best Practices  warn

  errors-in-console  moderate  1 item  warn
      Description: Failed to load resource: the server responded with a status of 404 (Not Found)
      http://127.0.0.1:52817/favicon.ico:1:0

  failing from serious up

fail · image-alt, color-contrast
```

**Always audit a production build.** A dev server ships unbundled modules, with
no minification and no cache: the numbers it produces describe nothing your
visitors will ever see. And Kanso builds nothing: after a change, build again,
or the audit measures the build before it.

Kanso returns two kinds of result. Performance gives you **measures** — five
numbers, read against your budgets:

| | What it is | Good below |
|---|---|---|
| **Performance** | the overall Lighthouse score | (above 90) |
| **LCP** | when the largest visible element shows up | 2,500 ms |
| **TBT** | how long the page ignores clicks | 200 ms |
| **CLS** | how much the layout jumps around | 0.1 |
| **FCP** | when the first pixel of content appears | 1,800 ms |

When one of them does not pass, Kanso prints what Lighthouse found behind it:

```
  LCP element      body > img  <img src="/hero.png" width="1600" height="900">
  LCP, observed    32ms = 2ms to first byte + 4ms load delay + 7ms load duration + 19ms render delay
  render-blocking  http://localhost:4173/assets/index.css  152ms
  layout shifts    main  0.365  Unsized image element: body > img  <img src="/hero.png" …>
```

Those timings come from the page load as it happened, while the table's numbers
are Lighthouse's simulation of a slower device: read them as where the time
goes, not as the metric itself.

Accessibility gives you **findings**: a rule broken, on named elements. No
average, no median — a rule is violated or it is not. Each one carries the
impact axe gives it, the engine Lighthouse runs:

| Impact | Example |
|---|---|
| `critical` | an image with no text alternative, a field with no label |
| `serious` | unreadable contrast, a link with no accessible name |
| `moderate` | a heading structure that skips a level |
| `minor` | hygiene — nothing that locks anyone out |

By default a `serious` or `critical` finding fails the audit and the rest warn.
The first three failing elements are printed under each rule, with what axe says
is wrong with them — for a contrast failure, the ratio and both colours — so you
know where to start. `--json` carries every element.

SEO and best practices give you findings too, read and judged exactly the same
way. Lighthouse ranks none of their rules, so Kanso places each one on the same
impact scale — which is what lets one `fail_on` mean the same thing everywhere:

| | Fails by default (`serious` and up) | Warns |
|---|---|---|
| **SEO** | the page tells search engines not to index it; an invalid canonical | no meta description, links a crawler cannot follow, an invalid `hreflang` or `robots.txt`, vague link text |
| **Best practices** | not served over HTTPS; a field that refuses a paste | console errors, deprecated APIs, no doctype or charset, permission prompts on load, badly sized images |

The full ranking, with the reason for each rule, is in
`src/modules/seo/rules.js` and `src/modules/best-practices/rules.js`. A missing
`<title>` and an image without `alt` belong to both Lighthouse categories;
Kanso reports them once, under accessibility.

Not every failure is an element: a console error is printed with the script and
line that logged it, a missing doctype with what Lighthouse says of it.

Two things Lighthouse does not check, and so neither does Kanso yet: a
**missing** canonical (it only judges one that is there) and Open Graph tags. A
page with neither scores 100 in SEO.

Best practices also reports, without judging it, what Lighthouse says of the
security headers the page was served with — CSP, HSTS, COOP, frame control,
Trusted Types — which it lists without scoring. They are in `--json` and in what
the MCP server returns: a local static server sends none of those headers, so
they mean something on a deployed URL, not on `localhost`.

## 4. Compare two versions

The most useful thing it does day to day: *did what I just wrote cost
anything?*

```bash
kanso audit dist --baseline ../main/dist    # the same project, built from main
kanso audit dist --baseline https://example.com
```

```
Kanso · dist
against ../main/dist · mobile + desktop · 1 run per page · 18s

Performance  warn

mobile
               baseline  current       Δ
  Performance        96       91      -5  pass
  LCP            2100ms   2680ms  +580ms  warn
  TBT              90ms    210ms  +120ms  warn
  CLS              0.02     0.02   +0.00  pass
  FCP            1310ms   1400ms   +90ms  pass

desktop
  …

Accessibility  fail

  image-alt       critical  1 element   new        fail
      main > p:nth-child(2)
  color-contrast  serious   4 elements  inherited  pass

  failing from serious up · 1 already in the baseline · 1 fixed

fail · image-alt
```

The `baseline` column replaces the `budget` column, and `Δ` is the gap. Two
build directories are the fairest comparison there is: Kanso serves both, side
by side, so the hosting is identical and only the code differs.

`--baseline` also changes how findings are judged. Without it, Kanso judges
**the page as it stands**, and everything counts. With it, Kanso judges **what
your change did**: a rule the reference already breaks, on as many elements, is
reported (`inherited`) but never fails the audit. Nobody reads forty inherited
violations; everybody reads the two their branch just added.

> Comparing a local build against production also measures the difference in
> hosting — CDN, cache, compression — not just your code. Worth remembering when
> a gap surprises you.

## 5. Set your thresholds

Create a `.kanso.yml` at the root of your web project:

```yaml
# Past these values the verdict is `fail`.
budgets:
  performance: 90    # minimum score
  lcp: 2500          # ms
  tbt: 200           # ms
  cls: 0.1
  fcp: 1800          # ms

# Accessibility, SEO, best practices: the impact from which a finding fails
# the audit. minor | moderate | serious | critical
accessibility:
  fail_on: serious
seo:
  fail_on: serious
  ignore: [is-crawlable]   # rules this project is not held to — see below
best-practices:
  fail_on: moderate

# Page loads per page and per form factor; the median is kept.
# It counts page loads, and one load feeds every module — which is why it stays
# at the root of the file rather than under one of them.
runs: 3

# What `kanso audit` audits when you name no page: the directory your build
# writes. Relative to this file.
serve:
  dir: dist
```

Each module reads the section carrying its name. Performance's `budgets:` live
at the root, where every `.kanso.yml` written so far keeps them;
`performance: { budgets: ... }` works too, and wins.

`ignore:` takes the rules a project has decided not to be held to, in any of the
three findings sections; an ignored rule is neither reported nor judged, and the
report says it was left out. The case it exists for: Vercel, Netlify and
Cloudflare Pages send `X-Robots-Tag: noindex` with every preview deployment, so a
preview audited against production — or against nothing — fails `is-crawlable`
on every pull request. A preview of the base branch carries the same header,
which makes the finding inherited and needs no ignore.

Kanso reads the file from the directory you run the command in. Missing values
fall back to the defaults, which are Lighthouse's "poor" boundaries —
deliberately lax, so nothing is red by surprise on day one.

**`serve:` tells Kanso how to serve the project**, so that `kanso audit`, your
coding agent and your CI need no URL and no knowledge of your tooling. Either a
directory of built files, as above, or the command your project serves itself
with, when it needs its own server — server-side rendering, a worker runtime:

```yaml
serve:
  command: npm run preview        # run from this file's directory
  url: http://localhost:4173      # where the command serves the page
```

Kanso starts the command, waits until the URL answers, audits it, and stops the
command and everything it started. It refuses to start one when something
already answers at that URL: an audit of a server Kanso did not start could be
an audit of anything. `serve:` is read by the CLI, the MCP server and the
GitHub Action — never by a Kanso server auditing a pull request, which runs no
command a repository names.

**The same file serves CI and pull requests.** A local audit and a PR audit
therefore judge a page by the same numbers.

## 6. Fail a build on a regression

The exit code **is** the verdict:

| Code | What happened |
|---|---|
| `0` | audited, nothing above the threshold |
| `1` | audited, something went over |
| `2` | the audit could not run (no Chrome, page unreachable…) |

Which is all a CI job needs:

```yaml
- run: npm run build
- run: kanso audit dist --fail-on warn --out kanso.md
```

`--fail-on warn` is stricter: it fails on the amber zone rather than waiting for
red. `--out` writes the report to a file as well — Markdown for a `.md`, the one
a pull request gets; JSON for a `.json` — and can be given twice. For a report
meant for a script rather than a human, `--json` prints the whole result and
nothing else:

```bash
kanso audit dist --json > audit.json
```

### On GitHub Actions

The repository is an action. It runs the CLI in your own runner, with the
runner's Chrome: nothing to host, no token, no permission to grant. The report
goes to the job summary, and the job fails on a regression:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build
- uses: valajan/kanso-api@main
  with:
    url: dist                          # or leave it out, with serve: in .kanso.yml
    baseline: https://example.com      # optional: judge the change, not the page
```

| Input | |
|---|---|
| `url` | a URL or a build directory; defaults to `serve:` |
| `baseline` | a URL or a build directory to compare against |
| `runs` | page loads per page and form factor, median kept |
| `fail-on` | `fail` (default) or `warn` |
| `config` | another configuration file |
| `working-directory` | the project, in a monorepo |

Its outputs are `conclusion` (`pass`, `warn`, `fail`, or `error`), and the paths
of the Markdown `report` and the JSON `result`, for a later step to upload or
post.

Needing no permission is also why it works on a pull request from a fork, whose
token cannot write. Do not reach for `pull_request_target` to post a comment
from there: it runs the fork's code with a token that can write to your
repository. The safe way is a second workflow, on `workflow_run`, posting a
report the first one uploaded.

The fairest comparison builds the base branch in the same job and hands both
directories to Kanso: same runner, same Chrome, same server, only the code
differs. [`integrations/kanso-action.example.yml`](integrations/kanso-action.example.yml)
does exactly that.

## 7. Give it to your coding agent

`kanso mcp` serves the same audit over [MCP](https://modelcontextprotocol.io) on
stdin and stdout. The agent that just wrote the component can measure it instead
of telling you it looks fine.

In Claude Code, from your web project:

```bash
claude mcp add kanso -- kanso mcp
```

In Cursor, Claude Desktop, or any other host — `.cursor/mcp.json`, `.mcp.json`,
`claude_desktop_config.json`, same shape:

```json
{
  "mcpServers": {
    "kanso": { "command": "kanso", "args": ["mcp"] }
  }
}
```

> Without `npm link`, the command is `node` with
> `["/path/to/kanso/bin/kanso.js", "mcp"]` as its arguments.

Two tools:

| Tool | Arguments | What comes back |
|---|---|---|
| `audit_page` | `url` (a URL or a build directory; defaults to `serve:`), optional `baseline` and `runs` | the whole verdict, as JSON |
| `list_modules` | none | what Kanso checks, what this project judges it against, and how it is served |

The server reads `.kanso.yml` from the directory the host started it in — your
project — so the agent is held to the same numbers you are.

Three things worth knowing before you wire it up:

**Serve the build, or let Kanso.** An agent auditing `npm run dev` measures the
dev server: unbundled modules, no minification, numbers that mean nothing. With
a `serve:` block in `.kanso.yml`, `audit_page` needs no URL at all — Kanso
serves the project the way the file says, and the agent never has to work out
how. Kanso still builds nothing: the agent builds after a change, or it measures
the build before it.

Because `audit_page` may start the command your `.kanso.yml` names, it is not
flagged read-only to the host.

**It returns facts, not an opinion.** Kanso never calls a model from here. In MCP
the host *is* the model, and it has the diff it just wrote in front of it — more
context than any report could reconstruct. (The AI analysis in `src/ai-analysis/`
belongs to the pull request surface, where there is no agent reading the numbers.)

**A call takes 10 to 60 seconds** — one page load per form factor, times `runs`,
doubled when you pass a `baseline`. Kanso sends progress notifications while it
works, which is what stops a host giving up mid-audit; if yours times out anyway,
raise its limit (`MCP_TOOL_TIMEOUT` in Claude Code) or leave `runs` at 1.

## 8. On a pull request

Kanso can post its report into the PR itself: one comment carrying the tables,
edited on every push rather than stacked, and a commit status that blocks the
merge when something fails.

That path needs a Kanso instance your CI can reach (`npm start`, or the
`Dockerfile` in this repo). The CI job hands it the preview URL it just
deployed:

```yaml
- uses: ./integrations/github-action
  with:
    api-url: https://kanso.example.com
    preview-url: ${{ steps.deploy.outputs.url }}
    base-url: https://example.com
```

The details — token permissions, GitLab, waiting for the preview — are in
[`integrations/README.md`](integrations/README.md).

> For a check in CI with nothing to host, the action of §6 runs the CLI in your
> own runner instead. This path is for the report in the pull request itself,
> and for the GitHub App that finds the preview on its own.

## 9. When the numbers move between runs

That is normal, and it is the classic trap: a single Lighthouse load swings by
20–30% on TBT depending on what your machine is doing at that moment. Enough to
fail a good change on its own.

The remedy is `runs: 3` in `.kanso.yml` (or `--runs 3`): Kanso loads the page
three times and keeps the median of each metric. It triples the audit, and it
makes a small regression believable.

Close whatever is running in the background during an audit — a build, another
Chrome: they fight over the same CPU as the page being measured.

## 10. When it does not work

| Symptom | Usual cause |
|---|---|
| `error · CHROME_INTERSTITIAL_ERROR` | nothing is serving that port, or the server returns an error |
| `error · ...ChromeLauncher...` | Chrome is missing, or not where Kanso looks for it |
| Excellent scores, visibly slow page | you audited the dev server, not the build |
| `configuration file not found` | the path given to `--config` does not exist |
| `there is no dist directory to serve` | the project has not been built yet |
| `something already answers at …` | a server is already running where `serve.url` points: stop it, or audit that URL directly |
| `` `…` did not answer at … within 60s `` | `serve.url` is not where the command serves the page |
| Huge gaps with `--baseline` | you are comparing two hostings, not two codebases |

## 11. Under the hood

The audit is `src/core/audit.js`, and it knows nothing about pull requests,
forges or servers: the CLI, the MCP server and the PR report are three surfaces
onto the same core.

Each concern Kanso checks is a module under `src/modules/` — performance,
accessibility, SEO and best practices today — and every module extracts what it
needs from **the same page load**, so another concern costs a Lighthouse
category, not another audit.

Adding one is a folder plus one line in `src/modules/index.js`.
[`CLAUDE.md`](CLAUDE.md) documents the architecture in full.

---

## Cheat sheet

```bash
kanso audit dist                         # audit a build, served by Kanso
kanso audit <url>                        # audit a page already served
kanso audit                              # audit what serve: in .kanso.yml says
kanso audit <url> --baseline <url>       # compare against another version
kanso audit <url> --runs 3               # 3 loads, median kept
kanso audit <url> --fail-on warn         # fail on amber
kanso audit <url> --json                 # machine-readable output
kanso audit <url> --out report.md        # also write the Markdown report
kanso audit <url> --config other.yml     # another configuration file
kanso mcp                                # serve the audit to a coding agent
kanso --help
```
