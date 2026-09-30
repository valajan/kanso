import { dirname, resolve } from 'node:path';
import { loadLocalConfig } from '../config/local-config.js';
import { InvalidStates, parseStates, statesOn } from '../config/states.js';
import { audit } from '../core/audit.js';
import { clearRecord, writeRecord } from '../core/record.js';
import { clampRuns, MAX_RUNS } from '../core/runs.js';
import { InvalidTarget } from '../core/target.js';
import { ServeError, siteFromArgument, siteFromConfig, withSites } from '../serve/index.js';
import { InvalidParams } from './protocol.js';

// What Kanso hands an agent, and what it deliberately does not: facts, in the
// shape `kanso audit --json` prints them. No prose, no analysis, no second
// model. In MCP the host is the model — it has the code it just wrote in front
// of it, which is more than a report could ever reconstruct, and an opinion
// written here would only be one it has to read around.

// Nothing is sampled on the way out. An agent handed five of a rule's
// fifty-one elements reloaded the page in another tool for the other forty-six,
// and read them outside Kanso's judgement — no threshold, no new or inherited.
// The whole result costs less context than that detour.

// Silence is how a host decides a call has died. Every couple of seconds, the
// audit says how long it has been going, which is both a sign of life and the
// thing that resets the client's timeout.
const PROGRESS_INTERVAL_MS = 2000;

// The tools, bound to the directory the server was started in — which is the
// project whose .kanso.yml judges these audits.
export function createTools({ cwd = process.cwd(), runLoads, checkStates, now = Date.now } = {}) {
  return [auditPage({ cwd, runLoads, now }), checkStatesTool({ cwd, checkStates, now })];
}

function auditPage({ cwd, runLoads, now }) {
  return {
    name: 'audit_page',
    title: 'Audit a page',
    description:
      'Runs Kanso\'s probes through a page in Chrome, on mobile and desktop, and returns the verdict: '
      + 'pass, warn or fail, with every finding behind it — each failing element with its selector, its '
      + 'opening tag, its text and what is wrong with it (for a contrast failure, the ratio and both '
      + 'colours) — and every measure. '
      + 'Accessibility: axe\'s WCAG A/AA and best-practice rules; what axe cannot settle is marked needsReview. '
      + 'Laid out 320 CSS pixels wide (WCAG 1.4.10), whether it scrolls sideways (reflow-scroll) or cuts text '
      + 'off (reflow-clip), and which element does it; gone through with the Tab key, whether focus gets '
      + 'trapped (focus-trap), shows no sign or lands out of sight (focus-visible), or ends up behind a banner '
      + 'or a sticky bar (focus-obscured); loaded and scrolled through under prefers-reduced-motion: reduce, '
      + 'what still moves (reduced-motion). '
      + 'A check that could not run is listed under probeFailures with the rules it left unchecked: nothing '
      + 'found there is not a clean page. A check that needs a declared state, when the project declares none, '
      + 'does not run: each module lists it under skipped — { probe, rules, reason: "no-states" } — and its '
      + 'rules were not checked, not passed; check_states verifies the states you propose, and kanso discover '
      + '--write finds some by clicking through the page. '
      + 'When the project declares states — in its .kanso.yml, or in .kanso/states.yml, which kanso discover '
      + 'writes — a menu opened, a dialog shown, each reached by a click from the page as it loads or from the '
      + 'state it is listed under — axe, the 320 px reflow and the Tab walk read the page again in each, and a '
      + 'finding made there carries `at`, the name of the state; its level is keyed `rule@state`. A state that '
      + 'could not be reached is a probeFailure carrying `at`, and so is every state reached through it. '
      + 'Each state is also opened from the keyboard and closed with Escape, in a page of its own, and '
      + 'what focus does on the way is checked: a trigger no key opens (keyboard-inoperable), focus left '
      + 'nowhere (focus-lost), a modal dialog focus stays behind (focus-not-moved) or Tab gets out of '
      + '(focus-escapes-modal), a dialog or menu Escape leaves open (escape-not-closing) or that does not give '
      + 'focus back to its trigger (focus-not-returned), a disclosure whose content is not next in the Tab '
      + 'order (revealed-unreachable). '
      + 'Interactions opens and closes each declared state and reports what it leaves behind — a page left '
      + 'locked (page-locked), covered (overlay-left) or hidden from assistive technology (page-hidden-left), '
      + 'a scroll position or address lost (scroll-position-lost, url-left), a trigger still expanded '
      + '(expanded-left), an error on closing (close-error), a page that scrolls behind a modal dialog '
      + '(scroll-not-locked) — and, opening and closing each eight times, DOM nodes or listeners that keep '
      + 'growing (dom-leak, listener-leak). '
      + 'Performance: INP, timed on the clicks the states make, on a CPU slowed as a phone is: the slowest '
      + 'is the INP, judged against its budget (given in `budgets`), and its diagnostics name that click — '
      + 'its element, its state, and its input delay, processing and presentation. With no state declared, '
      + 'inp is null: not measured, never judged. '
      + 'Point it at a build, never at a dev server — the numbers of an unbundled page mean nothing: a URL '
      + '(a preview server, a container, a deployment), or a directory of built files, which Kanso serves '
      + 'itself. Leave the url out when the project\'s .kanso.yml has a serve: block: '
      + 'Kanso then serves the project as it says, starting and stopping its preview command if it names one. '
      + 'Kanso serves what is on disk and builds nothing, so build after a change, or the audit measures the '
      + 'build before it. '
      + 'Name a baseline to judge what a change did rather than what the page has always been: without one, '
      + 'every pre-existing finding counts against the page; with one, the ones the baseline already had are '
      + 'reported and not held against it. '
      + 'Name a record directory to keep a journal of what the checks did on each load — the page loaded, '
      + 'each state reached or not, each Tab stop, each finding with the path of its elements — one JSON '
      + 'Lines file per load, with frames of the page at the moments that explain a finding, beside the result '
      + 'as audit.json and an index.html that shows them all offline: for when a finding needs retracing to '
      + 'the moment that produced it. '
      + 'Takes 10 to 60 seconds per run, and reports progress while it works.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The page to audit: an http or https URL, localhost included, or a directory of built files, relative '
            + 'to the project. Defaults to what the serve: block of the project\'s .kanso.yml says.',
        },
        baseline: {
          type: 'string',
          description:
            'A second page to compare against, URL or directory: the same build before the change, the main '
            + 'branch, or production.',
        },
        record: {
          type: 'string',
          description:
            'A directory to keep the journal in, relative to the project: one file per page load, '
            + '<side>.<formFactor>.<run>.jsonl, its frames under frames/, the result as audit.json, and '
            + 'index.html, a page a person opens to see it all. What an earlier audit recorded '
            + 'there is replaced; nothing else in it is touched. The result says where it went, under record. '
            + 'Defaults to no journal.',
        },
        runs: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RUNS,
          description:
            `Page loads per page and form factor, 1 to ${MAX_RUNS}, the median INP kept. A click timed once `
            + 'swings from one load to the next, so 3 is what makes a small regression believable — at the cost '
            + 'of timing the states three times. Defaults to the project configuration.',
        },
      },
      additionalProperties: false,
    },
    // Kanso writes nothing itself unless asked for a record, and it is not
    // read-only either way: with no url, it runs the command the project's
    // .kanso.yml names to serve the build — a command it does not control,
    // and a host should not approve unseen on the strength of this hint. What
    // it starts, it stops. The open world is the page: the same URL audited
    // twice can differ.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },

    async run(args, { progress }) {
      const named = args.url == null ? null : site(args.url, 'url', cwd);
      const reference = args.baseline == null ? null : site(args.baseline, 'baseline', cwd);
      const recordDir = args.record == null ? null : recordArg(args.record, cwd);

      const { config, source } = loadLocalConfig({ cwd });
      config.runs = clampRuns(runsArg(args.runs) ?? config.runs);

      let page;
      try {
        page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
      } catch (err) {
        return notServed(err);
      }
      if (!page) throw new InvalidParams('url is required: the project has no serve: block in .kanso.yml saying how to serve it');

      // Cleared only once the audit is sure to run, as on the command line: a
      // call with a mistake in it leaves an earlier record as it was.
      if (recordDir) clearRecord(recordDir);

      const started = now();
      const stopTicking = tick(progress, started, now);
      let report;
      try {
        report = await withSites({ page, baseline: reference }, async ({ url, baseline, served }) => ({
          url,
          baseline,
          ...(served ? { served } : {}),
          // A baseline the caller named is always audited, as on the command
          // line: the comparison is what they asked for, budgets or no budgets.
          result: await audit({
            url, baseline, config, runLoads, alwaysCompare: true, record: recordDir,
          }),
        }));
      } catch (err) {
        return notServed(err);
      } finally {
        stopTicking();
      }

      const { result, ...sites } = report;
      const payload = {
        ...sites,
        runs: config.runs,
        configSource: source,
        elapsedMs: now() - started,
        ...result,
      };
      // The record holds the result as the call returned it, and the page that
      // shows it; the result says where the record is — the one thing
      // audit.json leaves out, since it sits in that directory.
      if (recordDir) {
        writeRecord(recordDir, payload);
        payload.record = recordDir;
      }

      // The same facts twice, on purpose: hosts that read structured output
      // get the object, the others get it serialized in the text block, and
      // neither ends up with a summary of the other.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        // A page that never loaded is the tool failing, not a verdict on the
        // page — and the model is told so rather than reading a clean page.
        isError: !result.ok,
      };
    },
  };
}

function checkStatesTool({ cwd, checkStates, now }) {
  return {
    name: 'check_states',
    title: 'Check the states of a page',
    description:
      'Checks the states you propose for a page against the page itself, so that what an audit goes through '
      + 'is what you meant. A state is what only a click shows — a menu opened, a dialog shown, a disclosure '
      + 'expanded, a tab selected, a drawer slid in — and the audit reads the page again in each: accessibility, '
      + 'the 320 px reflow, the Tab walk, INP, focus going in and out. You have the source, which is more than a '
      + 'click-through has: read it for what opens what (useState(isOpen), <Dialog open>, aria-controls, '
      + 'aria-expanded, a hidden attribute a button removes), and propose the states in the shape .kanso.yml\'s '
      + 'states: takes — name, click (a CSS selector), optional form_factor (mobile or desktop, for a state one '
      + 'screen alone has), optional wait_for (a selector that appears once it is open), optional close (what '
      + 'closes it when Escape does not), optional states (the ones reached from it, which start from it). '
      + 'Kanso replays each one from a first visit, in a page of its own, on mobile and on desktop, the way an '
      + 'audit will — under guards: no request that writes, no navigation, no window, no dialog is let through, '
      + 'and a click that needed one is not reached, since an audit has no guard and would do it for real. '
      + 'Only clicks are replayed: no hover, no typing, no key. '
      + 'The result is facts, per screen and per state, for you to act on; nothing is written. '
      + '`reached` says whether the state was reached; when not, `step` says where it failed — path (a state it '
      + 'starts from was not reached, named in `through`), click (nothing visible matches), wait_for (what says it '
      + 'opened never did), guards (what was stopped, in `stopped`), left (the click changed the address: another '
      + 'page, not a state) — and `reason` says it in words. `click` says how many elements the selector matches '
      + 'and how many are visible: Puppeteer clicks the first, so a selector matching two follows the page\'s '
      + 'order — and gives the element it clicked, by role and name, with `steadiest`, the selector that finds it '
      + 'alone, which you can adopt; `refused` says a rule the exploration keeps (a button named like Delete, a '
      + 'field, a link) would not have let it touch that element. A selector whose first match is hidden fails '
      + 'on it, even when a later one is shown: `visibleMatch` then describes the one shown, with its '
      + 'steadiest selector; one that matches only hidden elements is a state this screen does not have — '
      + 'form_factor: keeps it to the other. `waitFor` counts what wait_for matches before '
      + 'the click and after: one already there before waits for nothing. `changed` says whether the state shows '
      + 'anything the page did not, and `appeared`, `disappeared` and `newText` say what — a click that changes '
      + 'nothing is no state. `duplicates` names the earlier state this one ends at too (two buttons opening the '
      + 'same dialog: keep one). `closesParent` names the state this one closes, which brings the page back to '
      + 'where it loaded — a dialog\'s ×: it is no state, but the close: of the state it is under. `close` says '
      + 'whether clicking the close: selector brings the page back to where the state started. `revealed` lists '
      + 'what can be clicked in the state that was not there before — role, name, steadiest selector, one per '
      + 'family of alike elements, `alike` counting them — which is where the states under it come from: propose '
      + 'them as nested states and check again. `stable` and `drift` say what differed between two first visits '
      + 'of the page, left out of every comparison. `summary` counts what came out: checked, reached, unreached, '
      + 'unchanged, duplicates, closesParent, closeBroken (a close: that does not close), ambiguous (a selector '
      + 'matching several), waitsForNothing, and `ok` when none of unreached, unchanged, duplicates, closesParent '
      + 'or closeBroken is above zero — a summary that is not ok is a list of states to fix, not a failed call. '
      + 'Once the states check out, write them yourself into .kanso.yml under states: — or keep them in '
      + '.kanso/states.yml, which kanso discover --write rewrites whole — and audit_page goes through them. '
      + 'Without `states`, it checks the ones the project already declares, in .kanso.yml and .kanso/states.yml: to see '
      + 'whether they still hold after a change. With none declared, there is nothing to check. '
      + 'Point it at a build, as audit_page: a URL or a directory of built files, or nothing when .kanso.yml has '
      + 'a serve: block. Takes about 5 seconds per state and per screen, the two screens going side by side, so '
      + 'a dozen states take a minute or so; it reports progress while it works.',
    inputSchema: {
      type: 'object',
      properties: {
        states: {
          type: 'array',
          description:
            'The states to check, in the shape .kanso.yml\'s states: takes. Defaults to the states the project '
            + 'declares, in .kanso.yml and .kanso/states.yml.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Letters, digits, - and _; unique among the states.' },
              click: { type: 'string', description: 'CSS selector of the element that opens the state.' },
              form_factor: { type: 'string', enum: ['mobile', 'desktop'], description: 'The one screen the state is on. Both when left out.' },
              wait_for: { type: 'string', description: 'CSS selector that matches once the state is open.' },
              close: { type: 'string', description: 'CSS selector of what closes the state when Escape does not.' },
              states: { type: 'array', description: 'States reached from this one, in the same shape.', items: { type: 'object' } },
            },
            required: ['name', 'click'],
          },
        },
        url: {
          type: 'string',
          description:
            'The page to check: an http or https URL, localhost included, or a directory of built files, relative '
            + 'to the project. Defaults to what the serve: block of the project\'s .kanso.yml says.',
        },
      },
      additionalProperties: false,
    },
    // As audit_page: with no url, it runs the command the project's .kanso.yml
    // names to serve the build, which a host should not approve unseen on the
    // strength of a read-only hint. The page itself is replayed under guards —
    // no request that writes, no navigation, no window and no dialog is let
    // through — and nothing is written to the project.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },

    async run(args, { progress }) {
      const named = args.url == null ? null : site(args.url, 'url', cwd);
      let proposed = null;
      if (args.states != null) {
        try {
          proposed = parseStates(args.states);
        } catch (err) {
          if (err instanceof InvalidStates) throw new InvalidParams(err.message);
          throw err;
        }
      }

      const { config, source } = loadLocalConfig({ cwd });
      const states = proposed ?? parseStates(config.states);
      if (states.length === 0) {
        return {
          content: [{ type: 'text', text: 'There are no states to check: none were given, and the project declares none. Read the source for what opens what — dialogs, menus, disclosures, tabs, drawers — and call check_states again with the states you propose.' }],
          isError: true,
        };
      }

      let page;
      try {
        page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
      } catch (err) {
        return notServed(err);
      }
      if (!page) throw new InvalidParams('url is required: the project has no serve: block in .kanso.yml saying how to serve it');

      const check = checkStates ?? (await import('../discover/check.js')).checkStates;
      const formFactors = ['mobile', 'desktop'];
      // One count over both screens, which go side by side: what has been
      // checked of what there is to check.
      const total = formFactors.reduce((sum, formFactor) => sum + statesOn(states, formFactor).length, 0);
      // Progress only ever goes up, so a state finished and a sign of life share
      // one counter: a host that hears nothing for a while thinks the call
      // has died, and a state can take longer than that to check.
      let done = 0;
      let beat = 0;
      let said = 'checking…';
      const started = now();
      progress(beat, said);
      const timer = setInterval(() => progress(++beat, `${said} ${Math.round((now() - started) / 1000)}s`), PROGRESS_INTERVAL_MS);
      timer.unref?.();
      const stopTicking = () => clearInterval(timer);
      let checked;
      try {
        checked = await withSites({ page }, async ({ url, served }) => ({
          ...(served ? { served } : {}),
          result: await check(url, states, {
            formFactors,
            onProgress: ({ formFactor, state }) => {
              done += 1;
              said = `checked ${state} on ${formFactor} (${done}/${total})`;
              progress(++beat, said);
            },
          }),
        }));
      } catch (err) {
        // A page that could not be loaded is the tool failing, not a finding
        // about a state: the message says which.
        if (err instanceof ServeError) return notServed(err);
        return { content: [{ type: 'text', text: `The page could not be checked: ${err.message}` }], isError: true };
      } finally {
        stopTicking();
      }

      const payload = {
        ...(checked.served ? { served: checked.served } : {}),
        configSource: source,
        elapsedMs: now() - started,
        ...checked.result,
      };
      // Not an error whatever `summary.ok` says: the check ran, and a state
      // that does not hold is the answer it was asked for.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: false,
      };
    },
  };
}

// A project Kanso could not serve is the tool failing, like a page that never
// loaded — and the message says what to fix. Anything else is not Kanso's to
// explain here.
function notServed(err) {
  if (err instanceof ServeError) return { content: [{ type: 'text', text: err.message }], isError: true };
  throw err;
}

function site(value, label, cwd) {
  if (typeof value !== 'string') throw new InvalidParams(`${label} must be a string`);
  try {
    // No URL guard here, as on the command line: see src/core/target.js.
    return siteFromArgument(value, label, cwd);
  } catch (err) {
    if (err instanceof InvalidTarget) throw new InvalidParams(err.message);
    throw err;
  }
}

// A record directory resolves against the project, as a directory to serve
// does: an agent names it the way it names the build.
function recordArg(value, cwd) {
  if (typeof value !== 'string' || value === '') throw new InvalidParams('record must be a directory path');
  return resolve(cwd, value);
}

function runsArg(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS) {
    throw new InvalidParams(`runs must be a whole number between 1 and ${MAX_RUNS}`);
  }
  return value;
}

// Progress counts seconds elapsed, with no total: an audit's duration is the
// page's to decide. The first one goes out before any page load, so a host
// knows the call was received rather than lost.
function tick(progress, started, now) {
  const elapsed = () => Math.round((now() - started) / 1000);
  progress(0, 'auditing…');
  const timer = setInterval(() => progress(elapsed(), `auditing… ${elapsed()}s`), PROGRESS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
