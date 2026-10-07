# Kanso

Kanso runs deterministic probes through a web page in Chrome — into the menus,
dialogs and panels it opens, and out of them — and returns a verdict: `pass`,
`warn` or `fail`. Accessibility, the keyboard, what a state leaves behind when it
closes, and how long a click takes to answer; on mobile **and** desktop; against
your own thresholds — and it can judge one version of a page against another.

Three ways to run it, from the simplest to the most integrated: **locally**
while you work, **from your coding agent** so it can measure what it just wrote,
and **in CI** to stop a regression before it merges.

---

## 1. Requirements

- **Node 22.19 or later** (`node -v`)
- **Google Chrome** installed — Kanso drives it, it does not ship it (another
  Chrome or Chromium: name it with `CHROME_PATH`)

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
against the configured budgets · mobile + desktop · 1 run per page · 21s

Performance  pass

mobile
       budget  current       Δ
  INP   500ms    136ms  -364ms  pass

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

Interactions  pass

  no findings

  failing from serious up

fail · image-alt, color-contrast
```

**Always audit a production build.** A dev server ships unbundled modules, with
no minification and no cache: what it answers describes nothing your visitors
will ever see. And Kanso builds nothing: after a change, build again,
or the audit measures the build before it.

Kanso returns two kinds of result. Performance gives you a **measure**, read
against its budget: **INP**, how long the page takes to show it heard a click —
good below 200 ms, poor above 500 ms.

INP is the Core Web Vital no page load measures: it times clicks, and nobody
clicks during a load. Kanso clicks, on the `states:` you declare (below), on a
CPU slowed four times on mobile as a phone's is taken to be, and reports the
slowest as the page's INP. Declare no state and INP is **not measured**: the
table says so, and judges nothing — never a green 0 ms. When it does not pass,
Kanso names the click and where its time went:

```
  INP interaction  click  header > button#open  "Menu"  @ menu
  INP, parts       640ms = 12ms input delay + 600ms processing + 28ms presentation
```

What a page costs as it loads — LCP, CLS and the rest — is Lighthouse's to
measure, and Lighthouse CI already gates it well: Kanso does not load the page
for it.

Accessibility and interactions give you **findings**: a rule broken, on named
elements. No
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
another size, or under a keyboard, Kanso's other probes check, each in a page
of its own — about a second per audit — and report under accessibility, on the
same scale:

| Rule | What it means | Impact |
|---|---|---|
| `reflow-scroll` | laid out 320 CSS pixels wide — a 1280 px window zoomed to 400% — the page scrolls sideways (WCAG 1.4.10) | `serious` |
| `reflow-clip` | at that width, text runs past an edge that cuts it — an `overflow: hidden` box, a fixed bar, the screen — and is lost | `moderate` |
| `focus-trap` | pressing Tab from the top, focus goes round part of the page, or stays on one element, and never gets past it (WCAG 2.1.2) — an open modal dialog is left alone | `critical` |
| `focus-visible` | an element takes focus with nothing on it changing — no outline, ring, border, background or underline, on it or around it — or takes it off the screen, invisible, or folded out of sight (WCAG 2.4.7) | `serious` |
| `focus-obscured` | a focused element is entirely behind something else: a cookie banner, a sticky bar (WCAG 2.4.11) | `moderate` |
| `reduced-motion` | with `prefers-reduced-motion: reduce` set, something still moves — on load, as the page is scrolled through, or forever: a transform, a position, a size, or smooth scrolling. Fades and colour changes are left alone | `moderate` |

Each names the element to fix: the box too wide for the screen, the code block
that neither wraps nor scrolls, the card that hides the end of its lines, the
button whose focus style was removed, the menu link that takes focus while the
menu is closed. What
WCAG lets need two dimensions — images, video, maps, data tables — is left out,
and so is anything that scrolls on its own or is truncated on purpose with an
ellipsis. `reflow-clip` warns rather than fails: a carousel peeking at its next
slide looks the same to it. If a check cannot run on a page, the report says so
and lists the rules it left unchecked, rather than showing a clean section.

**What only a click shows is checked too, if you say how to get there.** A menu
that opens, a dialog, a form behind a button: declare them at the root of
`.kanso.yml` and axe reads the page again in each — in the page it already
loaded, so a state costs a reading, not a load. The 320 px layout and the Tab
walk go through them too: a panel of fixed width, a menu link with no focus
ring are where they hide. The walk starts where the click left focus, and in
a modal dialog stays in it; since Tab moves the page, it reads each state in
a page loaded for it:

```yaml
states:
  - name: menu
    click: "[aria-label='Menu']"             # what to click to get there
    wait_for: "#menu[aria-expanded='true']"  # what says you are there (optional)
    states:
      - name: signup                         # reached from the menu, still open
        click: "#signup"
  - name: settings
    click: "#settings"                       # reached from the page as it loads
```

Each state is reached from the page as it loads, or from the state it is listed
under, as a visitor would, and reports what it shows broken that no reading
before it did: `button-name @ menu`.
Each click is also timed, and the slowest is the page's INP — so a state is
worth declaring for the interaction it measures as much as for what it shows.
Against a baseline, a state is compared with the same state there. A state that
cannot be reached — the button renamed, the menu that never opens — is reported
as unchecked, with every state listed under it, and never reads as a clean
one. A state only one screen has — the drawer behind a phone's menu button —
says `form_factor: mobile`, and is not looked for on desktop.

**The way into a state and out of it is checked from the keyboard.** Kanso
opens each declared state as a keyboard user would — focus on its trigger,
Enter, then Space — reads where focus went, closes it with Escape, and reads
again. What opened is read from the page: a modal dialog, a menu or listbox, or
what the trigger's `aria-controls` names. These are reported under
accessibility too:

| Rule | What it means | Impact |
|---|---|---|
| `keyboard-inoperable` | the trigger takes no focus, or neither Enter nor Space opens what a click opens (WCAG 2.1.1) | `moderate` |
| `focus-lost` | focus was on the page, and the state opening or closing left it nowhere (WCAG 2.4.3) | `serious` |
| `focus-not-moved` | a modal dialog opened, and focus stayed behind it (WCAG 2.4.3) | `serious` |
| `focus-escapes-modal` | Tab, inside an open modal dialog, reaches the page behind it (WCAG 2.4.3) | `serious` |
| `escape-not-closing` | Escape leaves a modal dialog or a menu open (ARIA Authoring Practices) | `moderate` |
| `focus-not-returned` | a modal dialog or a menu closed, and focus did not go back to what opened it (WCAG 2.4.3) | `moderate` |
| `revealed-unreachable` | a disclosure opened, and the next Tab from its trigger does not go into what it revealed — content put at the end of the page, a portal (WCAG 2.4.3) | `moderate` |

**Let your coding agent find them.** The agent that wrote the page has its
source, and knows what opens what better than a click-through guessing from
outside. Through the MCP server it proposes states in the shape above and calls
`check_states`: Kanso replays each one from a fresh visit, on mobile and
desktop, under the same guards as `kanso discover` (below), and reports facts —
whether it was reached and, if not, at which step and why; how many elements
its selector matches, and a steadier one when there is one; what the click
changed; a state that ends where another does, or that only closes its parent
(a dialog's ×, which belongs in `close:`); what it reveals to click next, for
the states under it. Nothing is written: the agent fixes what the check found,
checks again, and writes the states that hold into `.kanso.yml` itself.

In CI, nothing explores the page: `kanso discover --check` replays the states
you declared and exits `0` when each is reached, changes something and is no
other's duplicate, `1` when one is not, `2` when it could not run. A page that
changes under a state fails the job there, not as an audit that silently
checked less.

```bash
kanso discover dist --check    # replay the declared states, explore nothing
```

**Or let Kanso find a first draft.** `kanso discover` clicks through the page, two clicks
deep, on mobile and desktop, and prints what it found; `--write` writes it to
`.kanso/states.yml`, a file of its own beside your `.kanso.yml`, rewritten whole
each time the page changes — commit it, like a lock file:

```bash
kanso discover dist            # print the states found
kanso discover dist --write    # write them to .kanso/states.yml
```

| Option | |
|---|---|
| `--depth <n>` | clicks deep, 1 to 3 (default: 2) |
| `--max-clicks <n>` | clicks per screen before stopping (default: 60) |
| `--max-states <n>` | states kept at most, top-level ones first (default: 20) |
| `--form-factor <mobile \| desktop>` | explore one screen only (default: both) |
| `--json` | print what was found as JSON |

Twenty states are kept at most, a state never without the one it is reached
from, and the summary names the ones left out: an audit goes through every
state, at about 15 s each, and the summary says about how long that will take.

An audit reads both files. Keep in `.kanso.yml` only the states no
click-through can find — one behind a form to fill in, say — or one you want to
tell how to close another way: where both reach the same state, yours wins, and
what was found under it is reached from yours.

A button that brings back the page a state was opened on — a dialog's ×, a
drawer's Close — is not a state: it is written as that state's `close:`, which
the checks click when Escape does not close it (Escape is always tried first,
and still fails a dialog it leaves open). A close button one screen alone shows
is left out, since it would fail on the other. While a modal dialog is open,
only the dialog counts: two buttons that open the same one are one state, the
other named beside it in a comment. `--json` lists every click with what it
changed and what it came to, for a state you did not expect.

It only looks: nothing is typed, no form is sent, no other page is opened, a
button named like `Delete` or `Buy` is left alone, and any request that would
write is stopped before it leaves. A click that would have written, left the
page or raised a dialog is never kept as a state — an audit, which stops
nothing, would do it for real — and the summary says how many were left out. Each state it finds is reached a second time,
from a fresh visit, before it is kept — a state that comes back one time in two
would make every other audit unchecked. Read what it found before you commit
it: it names each state after what was clicked, and every state costs the
checks that go through it a few seconds more.

**Interactions** opens each declared state with a click and closes it however
it closes — Escape, its `close:`, a click away — then compares the page with
what it was before; and opens and closes each eight times, to see what keeps
growing. Nothing is checked there without a declared state.

| Rule | What it means | Impact |
|---|---|---|
| `page-locked` | the page no longer scrolls, or takes no click: the `overflow: hidden`, `position: fixed` or `pointer-events: none` a dialog puts on `<html>` or `<body>` is still there | `serious` |
| `overlay-left` | something still covers the middle of the page and takes its clicks — a backdrop that stayed | `serious` |
| `page-hidden-left` | what a modal dialog hid from assistive technology, or made inert, stays hidden | `serious` |
| `scroll-position-lost` | the page is no longer where it was scrolled to | `moderate` |
| `expanded-left` | the trigger still says `aria-expanded="true"` | `moderate` |
| `close-error` | an error, logged or thrown, as the state closed | `moderate` |
| `url-left` | the address is not the one the page had | `minor` |
| `scroll-not-locked` | while a modal dialog is open, the page behind it scrolls under the wheel | `minor` |
| `dom-leak` | DOM nodes, or documents, grow with every open and close, the first cycles left out as warm-up | `moderate` |
| `listener-leak` | event listeners grow with every open and close | `moderate` |

Not every failure is an element: an error thrown as a state closes is printed
with the script and line that threw it.

## 4. Compare two versions

The most useful thing it does day to day: *did what I just wrote cost
anything?*

```bash
kanso audit dist --baseline ../main/dist    # the same project, built from main
kanso audit dist --baseline https://example.com
```

```
Kanso · dist
against ../main/dist · mobile + desktop · 1 run per page · 38s

Performance  warn

mobile
       budget  baseline  current       Δ
  INP   500ms     136ms    248ms  +112ms  warn

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
# Past this value the verdict is `fail`.
budgets:
  inp: 200           # ms — timed on the states declared below

# Accessibility, interactions: the impact from which a finding fails the
# audit. minor | moderate | serious | critical
accessibility:
  fail_on: serious
  # Which axe rules run. The default covers WCAG A and AA in all three
  # versions, plus axe's structural best practices.
  tags: [wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a, wcag22aa, best-practice]
  ignore: [region]         # rules this project is not held to — see below
interactions:
  fail_on: moderate

# Page loads per page and per form factor; the median INP is kept.
# It counts page loads, and one load feeds every module — which is why it stays
# at the root of the file rather than under one of them.
runs: 3

# What `kanso audit` audits when you name no page: the directory your build
# writes. Relative to this file.
serve:
  dir: dist

# The states of the page the probes go through beyond the one it loads in — see section 3.
states:
  - name: menu
    click: "[aria-label='Menu']"
```

Each module reads the section carrying its name. Performance's `budgets:` live
at the root, where every `.kanso.yml` written so far keeps them;
`performance: { budgets: ... }` works too, and wins.

`ignore:` takes the rules a project has decided not to be held to, in either
findings section; an ignored rule is neither reported nor judged, and the report
says it was left out.

Kanso reads the file from the directory you run the command in. Missing values
fall back to the defaults — INP's "poor" boundary, `serious` for findings —
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
- run: kanso discover dist --check   # the declared states still open
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

### See what the probes did

When a finding surprises you, `--record <dir>` keeps what each probe went
through on each load:

```bash
kanso audit dist --record kanso-record
```

Every finding is pictured where it was found — as the page loads, or in the
state that shows it: a screenshot of that part of the page with the failing
elements outlined in red, numbered when there are several. An element behind
something else — a heading under an open menu — is outlined in dashes, with
what covers it: the picture shows the menu there, not the heading. Focus hidden
behind a sticky header is pictured as Tab reaches it, once for each thing that
hides. The directory
holds the same record twice, for its two readers:

- **`index.html`, for you.** One self-contained page that opens from the disk:
  every finding, worst first, with its pictures and, under each, which element
  is which and why it fails. *How it was found* unfolds the moments behind it —
  the page loaded, the state reached, the way in and out, focus boxes drawn
  over the frames.
- **`findings.json`, for your agent.** One entry per finding: its rule, its
  level, the state it was found in and the click that opens it, every failing
  element with what is wrong with it, and the paths of the pictures — images
  an agent can open, the boxes already in them — with where each numbered
  element is. Then what no probe could check, and what was timed.

Beside them: one JSON Lines journal per load — the page loaded, each state
reached or not, each finding, every stop of the Tab walk —, the frames under
`frames/`, and the whole result as `audit.json`. An element that takes no room
on the page when it is read — a link in a menu since closed — has no picture,
and the record says so. What an earlier audit wrote there is cleared first. The
Action (`record: true`) and the MCP server (`record: <dir>`) keep the same
directory.

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
| `runs` | page loads per page and form factor, median INP kept |
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
| `audit_page` | `url` (a URL or a build directory; defaults to `serve:`), optional `baseline`, `runs` and `record` | the whole verdict, as JSON — and with `record: <dir>`, `findings.json` with a picture of each failing element, and a journal of what the checks did on each load, kept in that directory, whose path the result gives |
| `check_states` | optional `states` (else the declared ones) and `url` | for each state, whether it was reached and what it changed, revealed or duplicated — see section 3 |

The server reads `.kanso.yml` from the directory the host started it in — your
project — so the agent is held to the same numbers you are.

Three things worth knowing before you wire it up:

**Serve the build, or let Kanso.** An agent auditing `npm run dev` checks the
dev server: unbundled modules, no minification, timings that mean nothing. With
a `serve:` block in `.kanso.yml`, `audit_page` needs no URL at all — Kanso
serves the project the way the file says, and the agent never has to work out
how. Kanso still builds nothing: the agent builds after a change, or it measures
the build before it.

Because `audit_page` may start the command your `.kanso.yml` names, it is not
flagged read-only to the host.

**It returns facts, not an opinion.** Kanso never calls a model. In MCP the host
*is* the model, and it has the diff it just wrote in front of it — more context
than any report could reconstruct.

**A call takes a few seconds to a few minutes** — about 15 s per declared state
on the screen with more, doubled when you pass a `baseline`. Kanso sends progress notifications while it
works, which is what stops a host giving up mid-audit; if yours times out anyway,
raise its limit (`MCP_TOOL_TIMEOUT` in Claude Code) or leave `runs` at 1.

## 8. When the INP moves between runs

That is normal: a click timed once swings with whatever your machine is doing
at that moment. Enough to fail a good change on its own.

The remedy is `runs: 3` in `.kanso.yml` (or `--runs 3`): Kanso times the states
three times and keeps the median. What the probes check rather than time is
settled on the first load, so only the timing is repeated.

Close whatever is running in the background during an audit — a build, another
Chrome: they fight over the same CPU as the page being timed.

## 9. When it does not work

| Symptom | Usual cause |
|---|---|
| `error · net::ERR_CONNECTION_REFUSED` | nothing is serving that port |
| `error · the page answered 404` | the server answers, with an error |
| `error · could not start Google Chrome…` | Chrome is missing, or not where Kanso looks for it: install it, or set `CHROME_PATH` |
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
accessibility and interactions today — declaring the probes it runs, and every
module's probes run on **the same Chrome**, so another concern costs its
probes, not another audit.

Adding one is a folder plus one line in `src/modules/index.js`.
[`CLAUDE.md`](CLAUDE.md) documents the architecture in full.

---

## Cheat sheet

```bash
kanso audit dist                         # audit a build, served by Kanso
kanso audit <url>                        # audit a page already served
kanso audit                              # audit what serve: in .kanso.yml says
kanso audit <url> --baseline <url>       # compare against another version
kanso audit <url> --runs 3               # INP timed 3 times, median kept
kanso audit <url> --fail-on warn         # fail on amber
kanso audit <url> --json                 # machine-readable output
kanso audit <url> --out report.md        # also write the Markdown report
kanso audit <url> --record <dir>         # keep index.html, findings.json and pictures of what failed
kanso audit <url> --config other.yml     # another configuration file
kanso discover dist --check              # replay the declared states, explore nothing
kanso discover dist --write              # find a first draft of the states, write .kanso/states.yml
kanso discover dist --max-states 10      # keep fewer states than the default 20
kanso mcp                                # serve the audit to a coding agent
kanso --help
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). It carries an express patent
grant, so contributors license their patent claims along with their code, and
users are covered.
