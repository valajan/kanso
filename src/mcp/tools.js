import { dirname, resolve } from 'node:path';
import { loadLocalConfig } from '../config/local-config.js';
import { moduleConfig } from '../config/module-config.js';
import { parseStates } from '../config/states.js';
import { probeRules } from '../probes/index.js';
import { audit } from '../core/audit.js';
import { clearRecord, writeRecord } from '../core/record.js';
import { clampRuns, MAX_RUNS } from '../core/runs.js';
import { InvalidTarget } from '../core/target.js';
import { MODULES } from '../modules/index.js';
import { ServeError, siteFromArgument, siteFromConfig, withSites } from '../serve/index.js';
import { InvalidParams } from './protocol.js';

// What Kanso hands an agent, and what it deliberately does not: facts, in the
// shape `kanso audit --json` prints them. No prose, no analysis, no second
// model. In MCP the host is the model — it has the code it just wrote in front
// of it, which is more than a report could ever reconstruct, and an opinion
// written here would only be one it has to read around.

// Nothing is sampled on the way out. An agent handed five of a rule's
// fifty-one elements reloaded the page in Lighthouse for the other forty-six,
// and read them outside Kanso's judgement — no threshold, no new or inherited.
// The whole result costs less context than that detour.

// Silence is how a host decides a call has died. Every couple of seconds, the
// audit says how long it has been going, which is both a sign of life and the
// thing that resets the client's timeout.
const PROGRESS_INTERVAL_MS = 2000;

// The tools, bound to the directory the server was started in — which is the
// project whose .kanso.yml judges these audits.
export function createTools({ cwd = process.cwd(), runLighthouse, now = Date.now } = {}) {
  return [auditPage({ cwd, runLighthouse, now }), listModules({ cwd })];
}

function auditPage({ cwd, runLighthouse, now }) {
  return {
    name: 'audit_page',
    title: 'Audit a page',
    description:
      'Loads a URL in Chrome on mobile and desktop, measures it and checks it, and returns the verdict: '
      + 'pass, warn or fail, with every metric and every accessibility, SEO and best-practices finding behind '
      + 'it — each failing element with its selector, its opening tag, its text and what is wrong with it '
      + '(for a contrast failure, the ratio and both colours); a failure that is no DOM element, such as a '
      + 'console error, carries the URL and line it names. '
      + 'Each performance metric is judged against its budget, given in `budgets`; a baseline is what it is '
      + 'compared to, never what it is judged by — a page equal to its baseline fails a budget both miss. '
      + 'Performance carries Lighthouse\'s diagnostics too: the LCP element and where its time went, the '
      + 'requests that blocked the first render, the elements that shifted and why. Their timings come from '
      + 'the unthrottled load, so they tell proportions, not the simulated metrics. '
      + 'INP, which Lighthouse cannot measure on a load, is timed by Kanso on the clicks the project\'s states '
      + 'make (see below), on a CPU slowed as Lighthouse slows it: the slowest is the INP, and its diagnostics '
      + 'name that click — its element, its state, and its input delay, processing and presentation. With no '
      + 'state declared, inp is null: not measured, never judged. '
      + 'Beyond Lighthouse, Kanso checks the page itself, and reports it as accessibility findings: laid out '
      + '320 CSS pixels wide (WCAG 1.4.10), whether it scrolls sideways (reflow-scroll) or cuts text off '
      + '(reflow-clip), and which element does it; gone through with the Tab key, whether focus gets trapped '
      + '(focus-trap), shows no sign or lands out of sight (focus-visible), or ends up behind a banner or a '
      + 'sticky bar (focus-obscured); loaded and scrolled through under prefers-reduced-motion: reduce, what '
      + 'still moves (reduced-motion). SEO also reports a page naming no canonical URL and missing Open '
      + 'Graph tags. A check that could not run is listed under probeFailures with the rules it left unchecked: '
      + 'nothing found there is not a clean page. A check that needs a declared state, when the project declares '
      + 'none, does not run: each module lists it under skipped — { probe, rules, reason: "no-states" } — and its '
      + 'rules were not checked, not passed; kanso discover --write finds the states. '
      + 'When the project declares states — in its .kanso.yml, or in .kanso/states.yml, which kanso discover writes (list_modules shows them) — a menu opened, a dialog '
      + 'shown, each reached by a click from the page as it loads or from the state it is listed under — axe reads the page again in each, and a finding '
      + 'made there carries `at`, the name of the state; its level is keyed `rule@state`. A state that could '
      + 'not be reached is a probeFailure carrying `at`, and so is every state reached through it. '
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
      + 'Best practices also carries, unjudged, what Lighthouse says of the security headers the page was '
      + 'served with (CSP, HSTS, COOP, frame control): a local static server sends none of the headers a host '
      + 'would, so their absence there says nothing about production. '
      + 'Point it at a build, never at a dev server — the numbers of an unbundled page mean nothing: a URL '
      + '(a preview server, a container, a deployment), or a directory of built files, which Kanso serves '
      + 'itself. Leave the url out when the project\'s .kanso.yml has a serve: block (list_modules shows it): '
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
        screenshot: {
          type: 'boolean',
          description:
            'Also return the page as its load ended, on mobile and on desktop: two images, after the result. '
            + 'They cost context — ask for them when how the page looks is the question: an element that '
            + 'overlaps another, a hero that renders blank, a layout that breaks. Defaults to false.',
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
            `Page loads per page and form factor, 1 to ${MAX_RUNS}, median kept. One Lighthouse load swings by `
            + '20-30% on TBT, so 3 is what makes a small regression believable — at three times the wait. '
            + 'Defaults to the project configuration.',
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
      if (args.screenshot != null && typeof args.screenshot !== 'boolean') throw new InvalidParams('screenshot must be true or false');
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
            url, baseline, config, runLighthouse, alwaysCompare: true,
            screenshots: args.screenshot === true, record: recordDir,
          }),
        }));
      } catch (err) {
        return notServed(err);
      } finally {
        stopTicking();
      }

      const { result, ...sites } = report;
      const { screenshots, ...audited } = result;
      const payload = {
        ...sites,
        runs: config.runs,
        configSource: source,
        elapsedMs: now() - started,
        ...audited,
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
      // neither ends up with a summary of the other. The screenshots are
      // images, not facts to read: they follow as image blocks, each named,
      // and stay out of both.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...images(screenshots)],
        structuredContent: payload,
        // A page that never loaded is the tool failing, not a verdict on the
        // page — and the model is told so rather than reading four green rows.
        isError: !result.ok,
      };
    },
  };
}

function listModules({ cwd }) {
  return {
    name: 'list_modules',
    title: 'List audit modules',
    description:
      'What Kanso checks on a page, and what it will judge it against: one module per concern — performance '
      + 'measures against budgets; accessibility, SEO and best-practices findings against an impact threshold, '
      + 'minus the rules the project ignores — each with the configuration resolved for this project; and how '
      + 'the project is served when audit_page is given no url, if it says. Call it to know what a verdict '
      + 'rests on before reading one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },

    async run() {
      const { config, source } = loadLocalConfig({ cwd });
      const payload = {
        configSource: source,
        // As the file says it, paths relative to the file: what audit_page
        // serves when it is given no url, or null when the project says nothing.
        serve: config.serve ?? null,
        runs: clampRuns(config.runs),
        // The states of the page the project declares beyond the one it loads
        // in, in the order they are reached — [] when it declares none.
        states: parseStates(config.states),
        modules: MODULES.map((mod) => ({
          id: mod.id,
          label: mod.label,
          lighthouseCategories: mod.categories,
          // What the module checks on the page itself, beyond Lighthouse, and
          // the rules each check can report — which, for a check the project
          // configures, is what this project's configuration makes of it.
          // `states` says whether a check reads the page again in each of
          // them, `transitions` whether it goes into and out of each.
          probes: (mod.probes ?? []).map((probe) => ({
            id: probe.id,
            rules: probeRules(probe, moduleConfig(config, mod.id)),
            states: probe.states === true,
            transitions: probe.transitions === true,
          })),
          // Each module sees only the section carrying its id, so this is the
          // whole of what judges it — see src/config/module-config.js.
          config: moduleConfig(config, mod.id),
        })),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
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

// Each screenshot as an image block, after a line saying which it is. A load
// that produced none is said too, rather than silently missing.
function images(screenshots) {
  if (!screenshots) return [];
  return Object.entries(screenshots).flatMap(([formFactor, uri]) => {
    const image = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(uri ?? '');
    if (!image) return [{ type: 'text', text: `No ${formFactor} screenshot: that load produced none.` }];
    return [
      { type: 'text', text: `The page on ${formFactor}, as its load ended:` },
      { type: 'image', data: image[2], mimeType: image[1] },
    ];
  });
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
