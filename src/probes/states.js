// Takes a page from one state to the next — src/config/states.js — the way a
// visitor would: back to the top, a click on what opens it, and a wait for
// what says it opened.
//
// The page is scrolled back to the top first. A check may have scrolled it —
// axe does, to read what is under a sticky header — and the next state must
// start from where a visitor who just arrived would be, not from wherever the
// last reading left it.

// How long a page is given to go quiet after the click — the request a menu
// makes for its items, the transition it opens with — when nothing says what
// to wait for, and after what was named has appeared. At least `idleTime` goes
// by, which is what lets a 300 ms transition finish before anything reads it.
const SETTLE_MS = 3_000;
const IDLE_MS = 500;

// Resolves once `state` is reached, and rejects with a message worth reading
// in a report when it cannot be: no element to click, or what should have
// appeared never did. `waitMs` is how long each of the two is waited for —
// well inside the time the whole step is allowed (src/probes/index.js), so
// that a state that is not there says which part was missing.
export async function applyState(page, { click, waitFor }, { waitMs }) {
  await page.evaluate('window.scrollTo(0, 0)');

  const target = await page.waitForSelector(click, { visible: true, timeout: waitMs })
    .catch(ifTimeout(`nothing visible to click at ${click}`));
  await target.click();
  await target.dispose();

  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: waitMs })
      .catch(ifTimeout(`clicked ${click}, and ${waitFor} never appeared`));
  }
  await page.waitForNetworkIdle({ idleTime: IDLE_MS, timeout: SETTLE_MS }).catch(() => {});
}

// A wait that ran out says what was missing; anything else — a selector that
// is no CSS — says what it is.
function ifTimeout(message) {
  return (err) => {
    throw err?.name === 'TimeoutError' ? new Error(message) : err;
  };
}
