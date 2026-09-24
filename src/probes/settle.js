import { inPage } from './dom.js';

// What a state is given, once a click or a key has opened or closed it, before
// anything reads it: the requests it makes, then the animations it plays. Both
// src/probes/states.js, as a state is reached, and src/probes/transition.js,
// as one opens or closes, wait the same way.
//
// The network going quiet is not enough. A panel that fades in over a second
// is in the page, and quiet, long before it is drawn as a visitor sees it:
// read half transparent, its text fails a contrast it passes once opaque, and
// a check reports what nobody ever sees. So the page's animations are waited
// on too — CSS transitions, CSS animations and the Web Animations a script
// starts, which the page lists alike (`document.getAnimations()`), in the
// document and in the frames of its own origin.
//
// Only the ones that will end: an animation that repeats forever — a spinner,
// a marquee, a pulsing badge — never finishes, and is left playing. So is one
// paused, or driven by the scroll rather than by time. What finishing starts
// — the fade that follows a slide — is waited on in turn, all within
// ANIMATIONS_MS: a page that keeps starting new ones is read as it stands once
// that has gone by, as a page that polls is read once SETTLE_MS has.
//
// Discover (src/discover/) reaches what it clicks through applyState, and so
// waits the same way.

// How long the page is given to go quiet on the network — at least IDLE_MS go
// by, at most SETTLE_MS — then to finish its animations.
const SETTLE_MS = 3_000;
const IDLE_MS = 500;
const ANIMATIONS_MS = 2_000;

// Resolves once the page has settled, or has been given the time to, to how
// long its animations were waited on, in ms — 0 when none was running. Never
// rejects: a page that goes as it is read — a click that left it — says so
// elsewhere, when it is read.
export async function settle(page) {
  await page.waitForNetworkIdle({ idleTime: IDLE_MS, timeout: SETTLE_MS }).catch(() => {});
  return animationsDone(page);
}

// Resolves once the page's finite animations have finished, or ANIMATIONS_MS
// have gone by, to how long that took.
function animationsDone(page, capMs = ANIMATIONS_MS) {
  return inPage(page, animationsDoneInPage, capMs).then((ms) => Math.round(ms), () => 0);
}

// --- in the page ----------------------------------------------------------------

async function animationsDoneInPage(dom, capMs) {
  const started = performance.now();
  const deadline = started + capMs;

  const documents = () => {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe, frame')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Another origin's: not ours to read.
      }
    }
    return docs;
  };
  // Playing, or about to, on the clock, and bound to end.
  const ending = (animation) => {
    // `running` includes an animation just created, still pending its first
    // frame — a transition the click has only just started.
    if (animation.playState !== 'running') return false;
    if (animation.playbackRate === 0) return false;
    // By name: a frame's timeline is of the frame's own DocumentTimeline.
    if (animation.timeline?.constructor.name !== 'DocumentTimeline') return false;
    const end = animation.effect?.getComputedTiming?.().endTime;
    return Number.isFinite(end);
  };

  // A few rounds: what finishing an animation starts is waited on too.
  for (let round = 0; round < 4; round++) {
    const running = documents().flatMap((doc) => doc.getAnimations?.() ?? []).filter(ending);
    const left = deadline - performance.now();
    if (running.length === 0 || left <= 0) break;
    let timer;
    await Promise.race([
      Promise.allSettled(running.map((animation) => animation.finished)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
    // One frame, for what a `transitionend` or `animationend` starts to be
    // listed.
    // A page in the background draws no frame: not waited on past 100 ms.
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
      setTimeout(resolve, 100);
    });
  }
  return performance.now() - started;
}
