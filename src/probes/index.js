import puppeteer from 'puppeteer-core';

import { moduleConfig } from '../config/module-config.js';
import { parseStates } from '../config/states.js';
import { applyState } from './states.js';

// Probes: what Kanso checks on a page itself, for what Lighthouse does not look
// at — how the page reflows at 320 CSS pixels, what a keyboard can reach. A
// module declares them (src/modules/index.js); this runs them, inside the audit
// worker, on the Chrome Lighthouse has just finished with.
//
// Each probe gets a page of its own, in a browser context of its own: a first
// visit, as Lighthouse's is, with nothing another probe clicked, scrolled or
// dismissed. Lighthouse's own tab is closed by then, and its throttling with
// it; a probe measures no time, and a slowed CPU would only make it slower.
// It sees the page as Lighthouse loaded it — same screen, same user agent —
// unless it asks for another screen.
//
// A probe that throws or runs out of time costs its own rules, not the load:
// what Lighthouse found stands, and the failure is reported, never read as
// "nothing found".

// How long one step of a probe may take: the load and its reading, or one
// state reached and read.
const PROBE_TIMEOUT_MS = 30_000;

// How long a loaded page is given to go quiet on the network — the requests a
// client-rendered page makes after `load` to draw itself — before a probe reads
// it anyway. Best effort: a page that polls never goes quiet.
const SETTLE_MS = 5_000;

// Runs every probe the modules declare for this form factor, one after the
// other, and resolves to { [moduleId]: { findings, failures } } — only for the
// modules that have probes to run. Each failure is { probe, rules, error }:
// `rules` are what the probe would have checked, and so what nobody did.
//
// - port:       the debugging port of the Chrome to use
// - settings:   the report's configSettings — how Lighthouse emulated the page
// - config:     the resolved .kanso.yml. A probe is handed its module's own
//               section of it, never the rest — the same rule the modules
//               themselves are held to (src/config/module-config.js). What a
//               probe checks can then be a matter of configuration, and its
//               `rules` a function of it.
//
// A probe that says `states: true` goes on through the states the project
// declares at the root of the file (src/config/states.js), in the page it
// loaded: it runs once as the page loads, then once more in each state, and a
// finding made in a state says which — `at: 'menu'` — and lists what that
// state showed broken that no reading before it had. The load is paid once,
// whatever the number of states. A probe that does not say so runs as the
// page loads, and its cost does not move.
//
// A state that cannot be reached stops the way through: it, and every state
// after it, are failures of their own — `at` says which — since what the page
// looks like there is unknown, and nothing found there would be nothing
// checked.
export async function runProbes({ port, url, formFactor, settings, modules, config = {}, timeoutMs = PROBE_TIMEOUT_MS }) {
  const wanted = modules.flatMap((mod) => (mod.probes ?? [])
    .filter((probe) => probe.formFactors?.includes(formFactor) ?? true)
    .map((probe) => ({ mod, probe, config: moduleConfig(config, mod.id) })));
  if (wanted.length === 0) return {};

  const declared = parseStates(config.states);
  const statesOf = (probe) => (probe.states ? declared : []);

  const results = {};
  for (const { mod } of wanted) results[mod.id] ??= { findings: [], failures: [] };
  const fail = (mod, probe, config, error, at = null) => results[mod.id].failures.push({
    probe: probe.id,
    rules: probeRules(probe, config),
    error,
    ...(at ? { at } : {}),
  });
  // A probe that never ran reached none of its states either.
  const failEverywhere = (mod, probe, config, err) => {
    fail(mod, probe, config, message(err));
    for (const { name } of statesOf(probe)) fail(mod, probe, config, message(err), name);
  };

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch (err) {
    for (const { mod, probe, config } of wanted) failEverywhere(mod, probe, config, err);
    return results;
  }

  try {
    // One at a time: a probe presses keys and reads focus, which only the page
    // in front has.
    for (const { mod, probe, config } of wanted) {
      try {
        const { findings, unreached } = await runProbe(browser, probe, { url, formFactor, settings, config, states: statesOf(probe), timeoutMs });
        results[mod.id].findings.push(...findings);
        if (unreached) {
          const [first, ...rest] = unreached.states;
          fail(mod, probe, config, message(unreached.error), first.name);
          for (const { name } of rest) fail(mod, probe, config, `not reached: ${first.name} could not be`, name);
        }
      } catch (err) {
        failEverywhere(mod, probe, config, err);
      }
    }
  } finally {
    await browser.disconnect().catch(() => {});
  }
  return results;
}

// One probe, in a page of its own: loaded, read, then taken through `states`,
// read again in each. Each step — the load and its reading, then each state
// and its reading — is allowed `timeoutMs` of its own. Resolves to the
// findings, and to `unreached` — { states, error } — when a state could not be
// reached: that state and the ones after it. Rejects when the page could not
// be read as it loaded.
async function runProbe(browser, probe, { url, formFactor, settings, config, states = [], timeoutMs }) {
  const context = await browser.createBrowserContext();
  const step = (work) => withTimeout(work, timeoutMs);
  try {
    const { page, found } = await step(async () => {
      const page = await context.newPage();
      // Scrollbars laid over the page, as on a phone or a Mac: a classic one
      // would take 15 px off the width a probe asked for.
      const session = await page.createCDPSession();
      await session.send('Emulation.setScrollbarsHidden', { hidden: true });
      await page.setViewport({ ...screen(settings), ...probe.viewport });
      if (typeof settings?.emulatedUserAgent === 'string') await page.setUserAgent(settings.emulatedUserAgent);
      if (probe.media) await page.emulateMediaFeatures(probe.media);
      if (probe.beforeLoad) await page.evaluateOnNewDocument(probe.beforeLoad);
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
      await page.bringToFront();
      return { page, found: await probe.run(page, { url, formFactor, config }) };
    });
    const findings = [...found];
    const seen = new Seen(found);

    for (const [i, state] of states.entries()) {
      try {
        const found = await step(async () => {
          await applyState(page, state, { waitMs: timeoutMs / 3 });
          return probe.run(page, { url, formFactor, config, at: state.name });
        });
        findings.push(...seen.added(found).map((finding) => ({ ...finding, at: state.name })));
      } catch (error) {
        return { findings, unreached: { states: states.slice(i), error } };
      }
    }
    return { findings };
  } finally {
    // Closing the context closes its page, and whatever the probe left
    // pending in it.
    await context.close().catch(() => {});
  }
}

// What the readings of one page have found so far, element by element, rule
// by rule. The states are cumulative, and the page's own faults are still
// there with the menu open: read as they are, a logo without alt would be
// reported as the page loads, then again in each state. A state reports what
// it adds — the elements no reading before it found broken — and a rule it
// adds nothing to is not reported there at all. Both pages under comparison
// are read the same way, so a state is still compared with the same state.
//
// An element is the one seen before when its DOM path is, or — for one with
// no path, found in a frame — when its selector and opening tag are. The
// count loses what was already reported, which is exact as long as every
// element was listed, and a close bound on a rule broken on more than
// MAX_NODES (src/modules/findings.js).
class Seen {
  #byRule = new Map();

  constructor(findings) {
    this.#remember(findings);
  }

  added(findings) {
    const fresh = findings.flatMap((finding) => {
      const before = this.#byRule.get(finding.rule) ?? new Set();
      const nodes = finding.nodes.filter((node) => !before.has(nodeKey(node)));
      const count = finding.count - (finding.nodes.length - nodes.length);
      return count > 0 ? [{ ...finding, count, nodes }] : [];
    });
    this.#remember(findings);
    return fresh;
  }

  #remember(findings) {
    for (const { rule, nodes } of findings) {
      if (!this.#byRule.has(rule)) this.#byRule.set(rule, new Set());
      for (const node of nodes) this.#byRule.get(rule).add(nodeKey(node));
    }
  }
}

function nodeKey({ path, selector, snippet }) {
  return path || `${selector}\n${snippet}`;
}

// `work()`, or a rejection once `ms` have gone by. Work that lost the race
// still settles later, when its context is closed under it: that rejection is
// expected, and nobody's to handle.
async function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  const running = work();
  running.catch(() => {});
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// What a probe covers: a fixed list, or — when what it checks is configurable
// — what the configuration makes of it. Either way it is what goes unchecked
// if the probe fails, so it is read the same way whether the probe ran or not,
// and a surface listing what Kanso checks reads it the same way too.
export function probeRules(probe, config) {
  return typeof probe.rules === 'function' ? probe.rules(config) : probe.rules;
}

// Lighthouse's screen emulation, as puppeteer takes a viewport.
function screen(settings) {
  const emulation = settings?.screenEmulation ?? {};
  const mobile = emulation.mobile ?? settings?.formFactor !== 'desktop';
  return {
    width: emulation.width ?? (mobile ? 412 : 1350),
    height: emulation.height ?? (mobile ? 823 : 940),
    deviceScaleFactor: emulation.deviceScaleFactor ?? 1,
    isMobile: mobile,
    hasTouch: mobile,
  };
}

function message(err) {
  return (err?.message ?? String(err)).split('\n')[0];
}
