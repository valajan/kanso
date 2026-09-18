# Kanso

Kanso loads a page in Chrome, measures what it costs, checks what it breaks, and
returns a verdict: `pass`, `warn` or `fail`. Performance and accessibility
today, in a single page load; on mobile **and** desktop; against your own
thresholds — and it can judge one version of a page against another.

Four ways to run it, from the simplest to the most integrated: **locally**
while you work, **from your coding agent** so it can measure what it just wrote,
**in CI** to stop a regression, **on a pull request** so the measurement lands in
the review.

---

## 1. Requirements

- **Node 20 or later** (`node -v`)
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

Kanso audits **a URL**, wherever it comes from. Locally, serve your build first:

```bash
# in your web project
npm run build
npx serve dist -l 4173        # or `npm run preview`, depending on your tooling
```

Then, in another terminal:

```bash
kanso audit http://localhost:4173
```

```
Kanso · http://localhost:4173/
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
      body > img.logo
  color-contrast     serious   2 elements  fail
      main > p.note
      footer > small
  landmark-one-main  moderate  1 element   warn
      html

  failing from serious up

fail · image-alt, color-contrast
```

**Always audit a production build.** A dev server ships unbundled modules, with
no minification and no cache: the numbers it produces describe nothing your
visitors will ever see.

Kanso returns two kinds of result. Performance gives you **measures** — five
numbers, read against your budgets:

| | What it is | Good below |
|---|---|---|
| **Performance** | the overall Lighthouse score | (above 90) |
| **LCP** | when the largest visible element shows up | 2,500 ms |
| **TBT** | how long the page ignores clicks | 200 ms |
| **CLS** | how much the layout jumps around | 0.1 |
| **FCP** | when the first pixel of content appears | 1,800 ms |

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
The first three failing elements are printed under each rule, so you know where
to start.

## 4. Compare two versions

The most useful thing it does day to day: *did what I just wrote cost
anything?*

```bash
kanso audit http://localhost:4173 --baseline http://localhost:4174
```

```
Kanso · http://localhost:4173/
against http://localhost:4174/ · mobile + desktop · 1 run per page · 18s

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
local builds served on two ports compare the same way — and more fairly, since
the hosting is then identical on both sides.

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

# Accessibility: the impact from which a finding fails the audit.
# minor | moderate | serious | critical
accessibility:
  fail_on: serious

# Page loads per page and per form factor; the median is kept.
# It counts page loads, and one load feeds every module — which is why it stays
# at the root of the file rather than under one of them.
runs: 3
```

Each module reads the section carrying its name. Performance's `budgets:` live
at the root, where every `.kanso.yml` written so far keeps them;
`performance: { budgets: ... }` works too, and wins.

Kanso reads the file from the directory you run the command in. Missing values
fall back to the defaults, which are Lighthouse's "poor" boundaries —
deliberately lax, so nothing is red by surprise on day one.

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
- run: npx serve dist -l 4173 &
- run: kanso audit http://localhost:4173 --fail-on warn
```

`--fail-on warn` is stricter: it fails on the amber zone rather than waiting for
red. For a report meant for a script rather than a human, `--json` prints the
whole result and nothing else:

```bash
kanso audit http://localhost:4173 --json > audit.json
```

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
| `audit_page` | `url`, optional `baseline` and `runs` | the whole verdict, as JSON |
| `list_modules` | none | what Kanso checks, and what this project judges it against |

The server reads `.kanso.yml` from the directory the host started it in — your
project — so the agent is held to the same numbers you are.

Three things worth knowing before you wire it up:

**Serve the build.** An agent auditing `npm run dev` measures the dev server:
unbundled modules, no minification, numbers that mean nothing. Build first, serve
the build, audit that.

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

> A second action that runs the CLI **inside the runner**, with nothing to host,
> is planned. Today this path needs the instance.

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
| Huge gaps with `--baseline` | you are comparing two hostings, not two codebases |

## 11. Under the hood

The audit is `src/core/audit.js`, and it knows nothing about pull requests,
forges or servers: the CLI, the MCP server and the PR report are three surfaces
onto the same core.

Each concern Kanso checks is a module under `src/modules/` — performance
and accessibility today — and every module extracts what it needs from **the
same page load**, so a second concern costs a Lighthouse category, not another
audit.

Adding one is a folder plus one line in `src/modules/index.js`.
[`CLAUDE.md`](CLAUDE.md) documents the architecture in full.

---

## Cheat sheet

```bash
kanso audit <url>                        # audit a page
kanso audit <url> --baseline <url>       # compare against another version
kanso audit <url> --runs 3               # 3 loads, median kept
kanso audit <url> --fail-on warn         # fail on amber
kanso audit <url> --json                 # machine-readable output
kanso audit <url> --config other.yml     # another configuration file
kanso mcp                                # serve the audit to a coding agent
kanso --help
```
