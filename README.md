# Kanso

Kanso loads a page in Chrome, measures what it costs, checks what it breaks, and
returns a verdict: `pass`, `warn` or `fail`. Performance, accessibility, SEO and
best practices today, in a single page load; on mobile **and** desktop; against
your own thresholds — and it can judge one version of a page against another.

Three ways to run it, from the simplest to the most integrated: **locally**
while you work, **from your coding agent** so it can measure what it just wrote,
and **in CI** to stop a regression before it merges.

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

Kanso returns two kinds of result. Performance gives you **measures** — six
numbers, read against your budgets:

| | What it is | Good below |
|---|---|---|
| **Performance** | the overall Lighthouse score | (above 90) |
| **LCP** | when the largest visible element shows up | 2,500 ms |
| **TBT** | how long the page ignores clicks | 200 ms |
| **CLS** | how much the layout jumps around | 0.1 |
| **FCP** | when the first pixel of content appears | 1,800 ms |
| **INP** | how long the page takes to show it heard a click | 200 ms |

INP is the Core Web Vital Lighthouse cannot measure: it times clicks, and
nobody clicks during a page load — Lighthouse puts TBT in its place. Kanso
clicks, on the `states:` you declare (section 3), on a CPU slowed as Lighthouse
slows it, and reports the slowest as the page's INP. Declare no state and INP
is **not measured**: the table says so, and judges nothing — never a green
0 ms.

When one of them does not pass, Kanso prints what Lighthouse found behind it:

```
  LCP element      body > img  <img src="/hero.png" width="1600" height="900">
  LCP, observed    32ms = 2ms to first byte + 4ms load delay + 7ms load duration + 19ms render delay
  render-blocking  http://localhost:4173/assets/index.css  152ms
  layout shifts    main  0.365  Unsized image element: body > img  <img src="/hero.png" …>
  INP interaction  click  header > button#open  "Menu"  @ menu
  INP, parts       640ms = 12ms input delay + 600ms processing + 28ms presentation
```

Those timings come from the page load as it happened, while the table's numbers
are Lighthouse's simulation of a slower device: read them as where the time
goes, not as the metric itself. INP's parts are the exception: they are the
click as it was timed, and add up to the number in the table.

Accessibility gives you **findings**: a rule broken, on named elements. No
average, no median — a rule is violated or it is not. Kanso runs axe-core on
the page itself, a hundred rules covering WCAG A and AA in all three versions
plus axe's structural best practices, and each finding carries the impact axe
gives it:

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

Some rules axe cannot settle on its own: text over a photograph has a contrast
no machine can compute. Those are reported too, marked **needs review**, with
their impact capped at `moderate` — worth telling you about, never enough to
fail a build by itself. A page nobody could check must not read as a page that
passed.

Which rules run is yours to choose:

```yaml
accessibility:
  fail_on: serious
  tags: [wcag2a, wcag2aa]     # WCAG 2.0 A and AA alone, without the rest
```

axe reads the page at one size, once, without touching it. What only shows at
another size, or under a keyboard, Kanso checks itself, each in a page of its
own after Lighthouse is done — about a second per audit — and reports under
accessibility, on the same scale:

| Rule | What it means | Impact |
|---|---|---|
| `reflow-scroll` | laid out 320 CSS pixels wide — a 1280 px window zoomed to 400% — the page scrolls sideways (WCAG 1.4.10) | `serious` |
| `reflow-clip` | at that width, text runs past an edge that cuts it — an `overflow: hidden` box, a fixed bar, the screen — and is lost | `moderate` |
| `focus-trap` | pressing Tab from the top, focus goes round part of the page, or stays on one element, and never gets past it (WCAG 2.1.2) — an open modal dialog is left alone | `critical` |
| `focus-visible` | an element takes focus with nothing on it changing — no outline, ring, border, background or underline, on it or around it — or takes it off the screen, invisible, or folded out of sight (WCAG 2.4.7) | `serious` |
| `focus-obscured` | a focused element is entirely behind something else: a cookie banner, a sticky bar (WCAG 2.4.11) | `moderate` |
| `reduced-motion` | with `prefers-reduced-motion: reduce` set, something still moves — on load, as the page is scrolled through, or forever: a transform, a position, a size, or smooth scrolling. Fades and colour changes are left alone | `moderate` |

**What only a click shows is checked too, if you say how to get there.** A menu
that opens, a dialog, a form behind a button: declare them at the root of
`.kanso.yml` and axe reads the page again in each — in the page it already
loaded, so a state costs a reading, not a load:

```yaml
states:
  - name: menu
    click: "[aria-label='Menu']"             # what to click to get there
    wait_for: "#menu[aria-expanded='true']"  # what says you are there (optional)
  - name: signup
    from: menu                               # reached from the menu, still open
    click: "#signup"
  - name: settings
    click: "#settings"                       # reached from the page as it loads
```

Each state is reached from the page as it loads, or from the state it names in
`from:`, as a visitor would, and reports what it shows broken that no reading
before it did: `button-name @ menu`.
Each click is also timed, and the slowest is the page's INP — so a state is
worth declaring for the interaction it measures as much as for what it shows.
Against a baseline, a state is compared with the same state there. A state that
cannot be reached — the button renamed, the menu that never opens — is reported
as unchecked, with every state reached through it, and never reads as a clean
one.

Each names the element to fix: the box too wide for the screen, the code block
that neither wraps nor scrolls, the card that hides the end of its lines, the
button whose focus style was removed, the menu link that takes focus while the
menu is closed. What
WCAG lets need two dimensions — images, video, maps, data tables — is left out,
and so is anything that scrolls on its own or is truncated on purpose with an
ellipsis. `reflow-clip` warns rather than fails: a carousel peeking at its next
slide looks the same to it. If a check cannot run on a page, the report says so
and lists the rules it left unchecked, rather than showing a clean section.

SEO and best practices give you findings too, read and judged exactly the same
way. Lighthouse ranks none of their rules, so Kanso places each one on the same
impact scale — which is what lets one `fail_on` mean the same thing everywhere:

| | Fails by default (`serious` and up) | Warns |
|---|---|---|
| **SEO** | the page tells search engines not to index it; an invalid canonical | no canonical at all, no meta description, links a crawler cannot follow, an invalid `hreflang` or `robots.txt`, vague link text, missing Open Graph tags |
| **Best practices** | not served over HTTPS; a field that refuses a paste | console errors, deprecated APIs, no doctype or charset, permission prompts on load, badly sized images |

The full ranking, with the reason for each rule, is in
`src/modules/seo/rules.js` and `src/modules/best-practices/rules.js`. A missing
`<title>` and an image without `alt` are SEO rules as well as accessibility
ones; Kanso reports them once, under accessibility.

Not every failure is an element: a console error is printed with the script and
line that logged it, a missing doctype with what Lighthouse says of it.

Two SEO rules are Kanso's own, from the same page load: Lighthouse judges a
canonical that is there but says nothing of a **missing** one, and ignores Open
Graph tags — a page with neither scores 100. Kanso reports `canonical-missing`
when the page names no canonical URL, in its head or in a `Link` header, and
`open-graph` when a link preview would lack its title, its text or its image —
or when `og:image` is a relative URL, which the sites fetching it cannot
resolve. Both warn by default.

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
               budget  baseline  current       Δ
  Performance      49        96       91      -5  pass
  LCP          4000ms    2100ms   2680ms  +580ms  warn
  TBT           600ms      90ms    210ms  +120ms  warn
  CLS            0.25      0.02     0.02   +0.00  pass
  FCP          3000ms    1310ms   1400ms   +90ms  pass

desktop
  …

Accessibility  fail

  image-alt       critical  1 element   new        fail
      main > p:nth-child(2)
  color-contrast  serious   4 elements  inherited  pass

  failing from serious up · 1 already in the baseline · 1 fixed

fail · image-alt
```

A `baseline` column joins the `budget` one, and `Δ` becomes the gap to the
baseline. The verdict still comes from the budget: a page that matches its
baseline fails anyway when both are over budget — and the budget on the same
line says why. Two build directories are the fairest comparison there is: Kanso
serves both, side by side, so the hosting is identical and only the code
differs.

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
  inp: 200           # ms — timed on the states declared below

# Accessibility, SEO, best practices: the impact from which a finding fails
# the audit. minor | moderate | serious | critical
accessibility:
  fail_on: serious
  # Which axe rules run. The default covers WCAG A and AA in all three
  # versions, plus axe's structural best practices.
  tags: [wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a, wcag22aa, best-practice]
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

# The states of the page axe reads beyond the one it loads in — see section 3.
states:
  - name: menu
    click: "[aria-label='Menu']"
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
GitHub Action alike.

**One file, every surface.** Your local audit, your agent's and your CI's all
judge a page by the same numbers.

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
red. `--out` writes the report to a file as well — Markdown for a `.md`, the one a
job summary shows; JSON for a `.json` — and can be given twice. For a report
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
- uses: valajan/kanso@main
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
| `record` | `true` to keep a journal of what the checks did on each load, uploaded as an artifact — a failed audit included |
| `record-name` | that artifact's name; defaults to `kanso-record-<job id>` |

Its outputs are `conclusion` (`pass`, `warn`, `fail`, or `error`), and the paths
of the Markdown `report` and the JSON `result`, for a later step to upload or
post — and, when recording, the `record` directory and the `record-url` of its
artifact.

Needing no permission is also why it works on a pull request from a fork, whose
token cannot write. Do not reach for `pull_request_target` to post a comment
from there: it runs the fork's code with a token that can write to your
repository. The safe way is a second workflow, on `workflow_run`, posting a
report the first one uploaded.

The fairest comparison builds the base branch in the same job and hands both
directories to Kanso: same runner, same Chrome, same server, only the code
differs. [`kanso-action.example.yml`](kanso-action.example.yml) does exactly
that.

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
| `audit_page` | `url` (a URL or a build directory; defaults to `serve:`), optional `baseline`, `runs`, `screenshot` and `record` | the whole verdict, as JSON — and with `screenshot: true`, the page as its load ended, on mobile and desktop, as two images; with `record: <dir>`, a journal of what the checks did on each load kept in that directory, whose path the result gives |
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

**It returns facts, not an opinion.** Kanso never calls a model. In MCP the host
*is* the model, and it has the diff it just wrote in front of it — more context
than any report could reconstruct.

**Screenshots are opt-in.** They are small — the last frame of Lighthouse's
trace, a few hundred pixels wide, about 20 KB each — but an image still costs
the agent context, so it asks for them when how the page looks is the question.

**A call takes 10 to 60 seconds** — one page load per form factor, times `runs`,
doubled when you pass a `baseline`. Kanso sends progress notifications while it
works, which is what stops a host giving up mid-audit; if yours times out anyway,
raise its limit (`MCP_TOOL_TIMEOUT` in Claude Code) or leave `runs` at 1.

## 8. When the numbers move between runs

That is normal, and it is the classic trap: a single Lighthouse load swings by
20–30% on TBT depending on what your machine is doing at that moment. Enough to
fail a good change on its own.

The remedy is `runs: 3` in `.kanso.yml` (or `--runs 3`): Kanso loads the page
three times and keeps the median of each metric. It triples the audit, and it
makes a small regression believable.

Close whatever is running in the background during an audit — a build, another
Chrome: they fight over the same CPU as the page being measured.

## 9. When it does not work

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

## 10. Under the hood

The audit is `src/core/audit.js`, and it knows nothing about terminals, agents
or runners: the CLI, the MCP server and the GitHub Action are three surfaces
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

## License

Apache License 2.0 — see [LICENSE](LICENSE). It carries an express patent
grant, so contributors license their patent claims along with their code, and
users are covered.
