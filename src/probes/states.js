import { settle } from './settle.js';

// Takes a page from one state to the next — src/config/states.js — the way a
// visitor would: back to the top, a click on what opens it, and a wait for
// what says it opened, then for the page to settle (./settle.js): the requests
// the state makes, the animations it opens with.
//
// The page is scrolled back to the top first. A check may have scrolled it —
// axe does, to read what is under a sticky header — and the next state must
// start from where a visitor who just arrived would be, not from wherever the
// last reading left it.

// Resolves once `state` is reached — to how long its animations were waited
// on, in ms — and rejects with a message worth reading in a report when it
// cannot be: no element to click, or what should have appeared never did. `waitMs` is how long each of the two is waited for —
// well inside the time the whole step is allowed (src/probes/index.js), so
// that a state that is not there says which part was missing. `fromTop: false`
// leaves the page scrolled where it is, for a check of what the state does to
// it.
export async function applyState(page, { click, waitFor }, { waitMs, fromTop = true }) {
  if (fromTop) await page.evaluate('window.scrollTo(0, 0)');

  const target = await page.waitForSelector(click, { visible: true, timeout: waitMs })
    .catch(ifTimeout(`nothing visible to click at ${click}`));
  await target.click();
  await target.dispose();

  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: waitMs })
      .catch(ifTimeout(`clicked ${click}, and ${waitFor} never appeared`));
  }
  return settle(page);
}

// Brings `page` to the last of `states`, from the page as it loads, one state
// after the other — the way to a state (`pathTo`, src/config/states.js), for a
// check that needs the page in the state the one it looks at starts from, in a
// page of its own. Rejects with
// the state that could not be reached, as `state`, beside the reason.
export async function reach(page, states, { waitMs, log }) {
  for (const state of states) {
    const started = Date.now();
    let animationsMs;
    try {
      animationsMs = await applyState(page, state, { waitMs });
    } catch (err) {
      err.state = state;
      throw err;
    }
    log.with({ at: state.name }).log('state-reached', { click: state.click, ms: Date.now() - started, ...(animationsMs ? { animationsMs } : {}) });
  }
}

// A wait that ran out says what was missing; anything else — a selector that
// is no CSS — says what it is.
function ifTimeout(message) {
  return (err) => {
    throw err?.name === 'TimeoutError' ? new Error(message) : err;
  };
}
