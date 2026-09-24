import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

import { NO_JOURNAL } from '../probes/journal.js';
import { reach } from '../probes/states.js';
import { DEFAULTS, explore } from './explore.js';
import { load, openPage } from './page.js';

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
// why; and, per screen, what the exploration came to.
export async function discover(url, { formFactors = ['mobile', 'desktop'], maxDepth = DEFAULTS.maxDepth, maxClicks = DEFAULTS.maxClicks, timeoutMs = DEFAULTS.timeoutMs, onProgress = () => {} } = {}) {
  // Built by hand rather than through chromeLauncher.launch(), for the reason
  // src/lighthouse/runner.worker.js gives: a Chrome whose port never opened
  // is killed here all the same.
  const chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  let browser;
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
      const { kept, left } = await replay(browser, formFactor, url, runs[formFactor].nodes);
      explored[formFactor] = kept;
      dropped.push(...left.map((node) => ({ formFactor, ...node })));
    }
    return {
      explored,
      dropped,
      runs: Object.fromEntries(formFactors.map((formFactor) => {
        const { clicks, stable, leftInQueue, outOfTime } = runs[formFactor];
        return [formFactor, { clicks: clicks.length, stable, leftInQueue, outOfTime }];
      })),
    };
  } finally {
    await browser?.disconnect().catch(() => {});
    chrome.kill();
  }
}

// Each state reached again, from a first visit, down its path. Resolves to the
// states that came back, and the ones that did not — each with the reason, or
// the state on its way that did not.
async function replay(browser, formFactor, url, nodes) {
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
      const states = pathOf(node).map(({ id, click, waitFor }) => ({ name: `state${id}`, click, ...(waitFor ? { waitFor } : {}) }));
      await reach(tab.page, states, { waitMs: 5_000, log: NO_JOURNAL });
      kept.push(node);
    } catch (err) {
      lost.add(node.id);
      left.push({ ...node, reason: err.message.split('\n')[0] });
    } finally {
      await tab.close();
    }
  }
  return { kept, left };
}
