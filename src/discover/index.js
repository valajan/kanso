import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

import { launchedPid, stopOnExit } from '../process/children.js';
import { NO_JOURNAL } from '../probes/journal.js';
import { applyState, reach } from '../probes/states.js';
import { DEFAULTS, explore } from './explore.js';
import { describeStopped, stoppedBy } from './guards.js';
import { load, openPage, settle } from './page.js';

// Finds the states of a page, so that nobody has to write `states:` by hand:
// the page explored on each screen Kanso audits (./explore.js), then each
// state found reached again, from a first visit, the way an audit will reach
// it (src/probes/states.js). A state that does not come back the second time
// is left out, with every state reached through it: a state that replays one
// time in two is a probe failure every other audit.
//
// Read-only, like the audit: nothing typed, nothing sent, no other page
// (./guards.js). No model, no key, no network but the page.
//
// Resolves to { explored: { [formFactor]: nodes }, dropped, runs }: the states
// kept on each screen, as ./explore.js lists them; the ones left out, with
// why; and, per screen, what the exploration came to — `guarded` naming each
// click not kept because the guards stopped something it did, `clicked`
// every click as ./explore.js records it.
export async function discover(url, { formFactors = ['mobile', 'desktop'], maxDepth = DEFAULTS.maxDepth, maxClicks = DEFAULTS.maxClicks, timeoutMs = DEFAULTS.timeoutMs, onProgress = () => {} } = {}) {
  // Built by hand rather than through chromeLauncher.launch(), for the reason
  // src/lighthouse/runner.worker.js gives: a Chrome whose port never opened
  // is killed here all the same.
  const chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  let browser;
  // Stopped should Kanso be interrupted, when this `finally` does not run —
  // from the moment it is spawned, launch not over (src/process/children.js).
  const release = stopOnExit(() => launchedPid(chrome));
  try {
    await chrome.launch();
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });

    // The two screens side by side: each click is a page of its own, in a
    // context of its own, and nothing here is timed.
    const runs = Object.fromEntries(await Promise.all(formFactors.map(async (formFactor) => {
      const run = await explore(browser, formFactor, url, {
        maxDepth, maxClicks, timeoutMs,
        onClick: (click) => onProgress({ formFactor, click }),
      });
      return [formFactor, run];
    })));

    const explored = {};
    const dropped = [];
    for (const formFactor of formFactors) {
      const { kept, left } = await replay(browser, formFactor, url, runs[formFactor].nodes, runs[formFactor].unprompted);
      explored[formFactor] = kept;
      dropped.push(...left.map((node) => ({ formFactor, ...node })));
    }
    return {
      explored,
      dropped,
      runs: Object.fromEntries(formFactors.map((formFactor) => {
        const { clicks, stable, leftInQueue, outOfTime } = runs[formFactor];
        // The clicks left out because the guards stopped something they did:
        // what a person reading the result needs to know was not missed but
        // refused, and why.
        const guarded = clicks.filter((c) => c.outcome === 'guarded').map(({ role, name, stopped }) => ({ role, name, stopped }));
        // And every click, with what it changed and what it came to: what
        // explains, after the fact, a state nobody expected — or one that
        // was expected and is not there.
        return [formFactor, { clicks: clicks.length, stable, leftInQueue, outOfTime, guarded, clicked: clicks }];
      })),
    };
  } finally {
    await browser?.disconnect().catch(() => {});
    chrome.kill();
    release();
  }
}

// Each state reached again, from a first visit, down its path — and closed,
// when the exploration found what closes it. Resolves to the states that came
// back, and the ones that did not — each with the reason, or the state on its
// way that did not.
//
// In a guarded page, as the exploration was: a replay during which the guards
// stopped something (./guards.js, `stoppedBy`, the page's own beacons left
// aside) has not replayed. The exploration found no such thing on the same
// clicks — but a page may write on the second visit what it did not on the
// first, and an audit, which has no guard, would send it for real.
async function replay(browser, formFactor, url, nodes, unprompted) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathOf = (node) => {
    const path = [];
    for (let at = node; at; at = at.parent == null ? null : byId.get(at.parent)) path.unshift(at);
    return path;
  };
  const kept = [];
  const left = [];
  const lost = new Set();
  for (const node of nodes) {
    if (node.parent != null && lost.has(node.parent)) {
      lost.add(node.id);
      left.push({ ...node, reason: 'reached through a state that did not replay' });
      continue;
    }
    const tab = await openPage(browser, formFactor);
    try {
      await load(tab, url);
      const blockedBefore = tab.guard.blocked.length;
      const states = pathOf(node).map(({ id, click, waitFor }) => ({ name: `state${id}`, click, ...(waitFor ? { waitFor } : {}) }));
      await reach(tab.page, states, { waitMs: 5_000, log: NO_JOURNAL });
      await settle(tab.page);
      const stopped = stoppedBy(tab.guard.blocked.slice(blockedBefore), unprompted);
      if (stopped.length > 0) throw new Error(`the guards stopped what it did (${stopped.map((b) => describeStopped(b, url)).join(', ')})`);
      kept.push(node.close && !(await closesAgain(tab, node.close, unprompted)) ? withoutClose(node) : node);
    } catch (err) {
      lost.add(node.id);
      left.push({ ...node, reason: err.message.split('\n')[0] });
    } finally {
      await tab.close();
    }
  }
  return { kept, left };
}

// Whether what closed a state closes it again, in the page just brought to
// it: there to be clicked, and clicked with nothing the guards must stop — an
// audit clicks it with no guard. A close that does not is left out, and the
// state kept: Escape and a click away from it are still tried
// (src/probes/transition.js).
async function closesAgain(tab, close, unprompted) {
  const blockedBefore = tab.guard.blocked.length;
  try {
    await applyState(tab.page, { click: close }, { waitMs: 5_000, fromTop: false });
    await settle(tab.page);
  } catch {
    return false;
  }
  return stoppedBy(tab.guard.blocked.slice(blockedBefore), unprompted).length === 0;
}

function withoutClose({ close, ...node }) {
  return node;
}
