import { loadLocalConfig } from '../config/local-config.js';
import { moduleConfig } from '../config/module-config.js';
import { audit } from '../core/audit.js';
import { clampRuns, MAX_RUNS } from '../core/runs.js';
import { InvalidTarget, parseTarget } from '../core/target.js';
import { MODULES } from '../modules/index.js';
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
      + 'Performance carries Lighthouse\'s diagnostics too: the LCP element and where its time went, the '
      + 'requests that blocked the first render, the elements that shifted and why. Their timings come from '
      + 'the unthrottled load, so they tell proportions, not the simulated metrics. '
      + 'Best practices also carries, unjudged, what Lighthouse says of the security headers the page was '
      + 'served with (CSP, HSTS, COOP, frame control): a local static server sends none of the headers a host '
      + 'would, so their absence there says nothing about production. '
      + 'Point it at a served build (a preview server, a container, a deployed URL), never at a dev server — '
      + 'the numbers of an unbundled page mean nothing. '
      + 'Name a baseline to judge what a change did rather than what the page has always been: without one, '
      + 'every pre-existing finding counts against the page; with one, the ones the baseline already had are '
      + 'reported and not held against it. '
      + 'Takes 10 to 60 seconds per run, and reports progress while it works.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to audit. http or https, localhost included.' },
        baseline: {
          type: 'string',
          description: 'A second page to compare against: the same build before the change, the main branch, or production.',
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
      required: ['url'],
      additionalProperties: false,
    },
    // It loads a page and reports on it; it writes nothing, anywhere. The open
    // world is the page: the same URL audited twice can differ.
    annotations: { readOnlyHint: true, openWorldHint: true },

    async run(args, { progress }) {
      if (args.url === undefined) throw new InvalidParams('url is required');
      const url = target(args.url, 'url');
      const baseline = args.baseline == null ? null : target(args.baseline, 'baseline');

      const { config, source } = loadLocalConfig({ cwd });
      config.runs = clampRuns(runsArg(args.runs) ?? config.runs);

      const started = now();
      const stopTicking = tick(progress, started, now);
      let result;
      try {
        // A baseline the caller named is always audited, as on the command
        // line: the comparison is what they asked for, budgets or no budgets.
        result = await audit({ url, baseline, config, runLighthouse, alwaysCompare: true });
      } finally {
        stopTicking();
      }

      const payload = {
        url,
        baseline,
        runs: config.runs,
        configSource: source,
        elapsedMs: now() - started,
        ...result,
      };

      // The same facts twice, on purpose: hosts that read structured output
      // get the object, the others get it serialized in the text block, and
      // neither ends up with a summary of the other.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
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
      + 'minus the rules the project ignores — each with the configuration resolved for this project. Call it '
      + 'to know what a verdict rests on before reading one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },

    async run() {
      const { config, source } = loadLocalConfig({ cwd });
      const payload = {
        configSource: source,
        runs: clampRuns(config.runs),
        modules: MODULES.map((mod) => ({
          id: mod.id,
          label: mod.label,
          lighthouseCategories: mod.categories,
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

function target(value, label) {
  if (typeof value !== 'string') throw new InvalidParams(`${label} must be a string`);
  try {
    // No URL guard here, as on the command line: see src/core/target.js.
    return parseTarget(value, label);
  } catch (err) {
    if (err instanceof InvalidTarget) throw new InvalidParams(err.message);
    throw err;
  }
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
