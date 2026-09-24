import puppeteer from 'puppeteer-core';

import { moduleConfig } from '../config/module-config.js';
import { parseStates, pathTo, walkOrder } from '../config/states.js';
import { findingEvent, NO_JOURNAL } from './journal.js';
import { applyState, reach } from './states.js';
import { transitionTools } from './transition.js';

// Probes: what Kanso checks on a page itself, for what Lighthouse does not look
// at — how the page reflows at 320 CSS pixels, what a keyboard can reach. A
// module declares them (src/modules/index.js); this runs them, inside the audit
// worker, on the Chrome Lighthouse has just finished with.
//
// Each probe gets a page of its own, in a browser context of its own: a first
// visit, as Lighthouse's is, with nothing another probe clicked, scrolled or
// dismissed. Lighthouse's own tab is closed by then, and its throttling with
// it; a probe that times nothing would only be made slower by a slowed CPU.
// It sees the page as Lighthouse loaded it — same screen, same user agent —
// unless it asks for another screen.
//
// A probe that measures time — `measures: true`, INP — gets the slowed
// CPU back: Lighthouse's multiplier, applied to its page alone, so that what
// it times is a phone's time and not the machine's running the audit.
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
// modules that have probes to run — with `measures` beside them for a module
// whose probe measures. Each failure is { probe, rules, error }: `rules` are
// what the probe would have checked, and so what nobody did.
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
// state showed broken that no reading before it had. The states are a tree,
// walked depth first (`walkOrder`): a state that starts from the one just read
// is reached in the same page, and one that starts down another branch in the
// page loaded again, brought to where it starts. A chain costs one load
// whatever its length; each branch after the first, one more. A probe that
// does not say so runs as the page loads, and its cost does not move.
//
// A state that cannot be reached is a failure of its own — `at` says which —
// and so is every state reached through it, since what the page looks like
// there is unknown, and nothing found there would be nothing checked. The
// other branches go on.
//
// A probe that says `onlyInStates: true` has nothing to read in a page nobody
// clicked, and is not run at all when no state is declared.
//
// A probe that says `transitions: true` checks the way into and out of each
// state rather than the state itself: what focus does when it opens, what is
// left when it closes. For each state, it gets a page of its own, brought to
// the state it starts from, and its `transition(page, state, context)` goes in
// and out with the tools src/probes/transition.js hands it. A state it could
// not check costs that state; one it could not reach on the way costs every
// state reached through it, as above. It needs a state, and does not run
// without one.
//
// With a `journal` (src/probes/journal.js), each probe's way through the page
// is logged — its load, each state, how it ended, each finding — and the probe
// is handed a `log` of its own for the rest. The page as it loaded and as each
// state showed is logged with a frame of it; not for a probe that measures,
// whose timing a screenshot would skew, nor for one that says `frames: false`
// — one that goes through the same moment again and again.
//
// With `measuresOnly`, only the probes that measure run: the others check
// what does not vary from one load to the next and ran on the first
// (src/lighthouse/runner.js), while a measure is taken on every load, to be
// folded into a median like Lighthouse's.
export async function runProbes({ port, url, formFactor, settings, modules, config = {}, measuresOnly = false, timeoutMs = PROBE_TIMEOUT_MS, journal = NO_JOURNAL }) {
  const declared = parseStates(config.states);
  const wanted = modules.flatMap((mod) => (mod.probes ?? [])
    .filter((probe) => probe.formFactors?.includes(formFactor) ?? true)
    .filter((probe) => !measuresOnly || probe.measures)
    .filter((probe) => !(probe.onlyInStates || probe.transitions) || declared.length > 0)
    .map((probe) => ({ mod, probe, config: moduleConfig(config, mod.id) })));
  if (wanted.length === 0) return {};

  const statesOf = (probe) => (probe.states || probe.transitions ? declared : []);

  const results = {};
  for (const { mod, probe } of wanted) {
    results[mod.id] ??= { findings: [], failures: [] };
    if (probe.measures) results[mod.id].measures ??= [];
  }
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
      const log = probe.measures || probe.frames === false ? journal.with({ probe: probe.id }).withoutFrames() : journal.with({ probe: probe.id });
      const started = Date.now();
      log.log('probe-start', { module: mod.id, states: statesOf(probe).map(({ name }) => name) });
      try {
        const run = probe.transitions ? runTransitions : runProbe;
        const { findings, unchecked } = await run(browser, probe, { url, formFactor, settings, config, states: statesOf(probe), timeoutMs, log });
        results[mod.id][probe.measures ? 'measures' : 'findings'].push(...findings);
        if (!probe.measures) for (const finding of findings) log.log('finding', findingEvent(finding));
        log.log('probe-end', { ms: Date.now() - started, findings: findings.length, ...(unchecked.length ? { unreached: unchecked.map(({ at }) => at) } : {}) });
        for (const { at, error } of unchecked) fail(mod, probe, config, message(error), at);
      } catch (err) {
        log.log('probe-failed', { ms: Date.now() - started, error: message(err) });
        failEverywhere(mod, probe, config, err);
      }
    }
  } finally {
    await browser.disconnect().catch(() => {});
  }
  return results;
}

// One probe, in a page of its own: loaded, read, then taken through `states`,
// read again in each — depth first, the page loaded again, in a context of its
// own, for each branch after the first. A measuring probe's readings are what
// it measured — an interaction's latency — and are kept as they are: two
// clicks on the same button are two measures, where they would be one finding.
// Each step — the load and its reading, a reload and the way back to where a
// branch starts, then each state and its reading — is allowed `timeoutMs` of
// its own. Resolves to the findings, and to `unchecked` — [{ at, error }] —
// for each state that could not be reached, and each reached through one.
// Rejects when the page could not be read as it loaded.
async function runProbe(browser, probe, { url, formFactor, settings, config, states = [], timeoutMs, log = NO_JOURNAL }) {
  const contexts = [];
  const open = async (at) => {
    // The page a branch leaves behind is not gone back to.
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})));
    const context = await browser.createBrowserContext();
    contexts.push(context);
    return loadPage(context, probe, { url, settings, timeoutMs, log: at });
  };
  const step = (work) => withTimeout(work, timeoutMs);
  try {
    let { page, found } = await step(async () => {
      const page = await open(log);
      return { page, found: await probe.run(page, { url, formFactor, config, log }) };
    });
    const findings = [...found];
    const unchecked = [];
    const seen = probe.measures ? null : new Seen(found);
    // Where the page stands: the state it is in, null as it loaded, undefined
    // once a state failed on it and nobody knows.
    let here = null;
    const missed = new Set();

    for (const state of walkOrder(states)) {
      const at = log.with({ at: state.name });
      const path = pathTo(states, state);
      const beyond = path.find(({ name }) => missed.has(name));
      if (beyond) {
        missed.add(state.name);
        unchecked.push({ at: state.name, error: new Error(`not reached: ${beyond.name} could not be`) });
        continue;
      }
      try {
        if (here !== (state.from ?? null)) {
          page = await step(async () => {
            const fresh = await open(at);
            await reach(fresh, path, { waitMs: timeoutMs / 3, log: at });
            // What the way back measured was measured the first time down it,
            // and is not this state's: read, and left out.
            if (probe.measures) await probe.run(fresh, { url, formFactor, config, log: at });
            return fresh;
          });
          here = state.from ?? null;
        }
        const found = await step(async () => {
          const started = Date.now();
          await applyState(page, state, { waitMs: timeoutMs / 3 });
          await at.shot(page, 'state-reached', { click: state.click, ...(state.waitFor ? { waitFor: state.waitFor } : {}), ms: Date.now() - started });
          return probe.run(page, { url, formFactor, config, at: state.name, log: at });
        });
        here = state.name;
        findings.push(...(seen ? seen.added(found) : found).map((finding) => ({ ...finding, at: state.name })));
      } catch (error) {
        here = undefined;
        missed.add(state.name);
        // A state on the way, reached the first time down it: the ones
        // reached through it lie beyond it now.
        if (error.state) missed.add(error.state.name);
        log.log('state-unreached', { at: (error.state ?? state).name, click: (error.state ?? state).click, error: message(error) });
        unchecked.push({ at: state.name, error });
      }
    }
    return { findings, unchecked };
  } finally {
    // Closing a context closes its page, and whatever the probe left pending
    // in it.
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  }
}

// A transition probe, state by state: for each, a page of its own in a
// context of its own, loaded, brought to the state it starts from, and handed
// to `probe.transition` with the tools to go in and out of this one. Resolves
// to the findings, each carrying its state, and to `unchecked` — [{ at, error
// }] — for each state whose check failed, or that is reached through one the
// way could not get past.
async function runTransitions(browser, probe, { url, formFactor, settings, config, states, timeoutMs, log = NO_JOURNAL }) {
  const findings = [];
  const unchecked = [];
  // The states the way could not get past, by name, with why.
  const missed = new Map();
  for (const state of states) {
    const at = log.with({ at: state.name });
    const path = pathTo(states, state);
    const beyond = path.find(({ name }) => missed.has(name));
    if (beyond) {
      unchecked.push({ at: state.name, error: new Error(`not reached: ${beyond.name} could not be (${missed.get(beyond.name)})`) });
      continue;
    }
    const context = await browser.createBrowserContext();
    try {
      const page = await withTimeout(() => loadPage(context, probe, { url, settings, timeoutMs, log: at }), timeoutMs);
      try {
        await withTimeout(() => reach(page, path, { waitMs: timeoutMs / 3, log: at }), timeoutMs);
      } catch (error) {
        // A state this one starts from, which its own turn may well have
        // opened: this one, and every one reached through it, lie beyond it.
        const stuck = error.state ?? path.at(-1);
        at.log('state-unreached', { at: stuck.name, click: stuck.click, error: message(error) });
        missed.set(stuck.name, message(error));
        unchecked.push({ at: state.name, error: new Error(`not reached: ${stuck.name} could not be (${message(error)})`) });
        continue;
      }
      try {
        const tools = transitionTools(page, state, { waitMs: timeoutMs / 3, log: at });
        const found = await withTimeout(() => probe.transition(page, state, { url, formFactor, config, log: at, ...tools }), timeoutMs);
        findings.push(...found.map((finding) => ({ ...finding, at: state.name })));
      } catch (error) {
        at.log('transition-failed', { error: message(error) });
        unchecked.push({ at: state.name, error });
      }
    } finally {
      await context.close().catch(() => {});
    }
  }
  return { findings, unchecked };
}

// A page for `probe`, loaded as Lighthouse loaded it — same screen, same user
// agent — unless the probe asks otherwise: another viewport, media features, a
// slowed CPU, a script of its own before the page's.
async function loadPage(context, probe, { url, settings, timeoutMs, log }) {
  const page = await context.newPage();
  // Scrollbars laid over the page, as on a phone or a Mac: a classic one
  // would take 15 px off the width a probe asked for.
  const session = await page.createCDPSession();
  await session.send('Emulation.setScrollbarsHidden', { hidden: true });
  await page.setViewport({ ...screen(settings), ...probe.viewport });
  if (typeof settings?.emulatedUserAgent === 'string') await page.setUserAgent(settings.emulatedUserAgent);
  if (probe.media) await page.emulateMediaFeatures(probe.media);
  if (probe.measures) await session.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown(settings) });
  if (probe.beforeLoad) await page.evaluateOnNewDocument(probe.beforeLoad);
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
  await page.bringToFront();
  await log.shot(page, 'loaded', { url, viewport: page.viewport(), ...(probe.media ? { media: probe.media } : {}) });
  return page;
}

// What the readings of one page have found so far, element by element, rule
// by rule. The page's own faults are still there with the menu open, and in
// every branch loaded again: read as they are, a logo without alt would be
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

// How much slower than the machine at hand Lighthouse took the page's device
// to be: 4 on mobile, 1 on desktop by default. Lighthouse applies it to a
// simulation; a probe gets it as DevTools applies it, to the real CPU.
function cpuSlowdown(settings) {
  const rate = settings?.throttling?.cpuSlowdownMultiplier;
  return Number.isFinite(rate) && rate >= 1 ? rate : 1;
}

function message(err) {
  return (err?.message ?? String(err)).split('\n')[0];
}
