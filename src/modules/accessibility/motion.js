import { MAX_NODES } from '../findings.js';
import { inPage } from '../../probes/dom.js';
import { impactOf } from './rules.js';

// The page for someone who asked their system for less motion — vestibular
// disorders, migraines: `prefers-reduced-motion: reduce`. What still moves is
// reported, element by element: what plays as the page loads, what plays as it
// is scrolled through, what never stops.
//
// Motion is what moves or resizes: a transform, a position, a size, a margin,
// a background sliding. A fade or a colour change is left alone — it is what
// reduced motion usually leaves in place of a movement — and so is anything
// shorter than a blink. Smooth scrolling kept on counts.
//
// What a script moves frame by frame, by hand (requestAnimationFrame, a canvas,
// a Lottie player), leaves no trace for the probe to read: only CSS animations
// and transitions, and animations made with the Web Animations API.
export const SHORTEST_MS = 200;

export const motion = {
  id: 'motion',
  rules: ['reduced-motion'],
  // Motion is a preference, not a device: one load is enough to see whether
  // the page honours it, and the mobile load is the one that runs it.
  formFactors: ['mobile'],
  media: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  beforeLoad: watchMotion,

  async run(page) {
    await inPage(page, sweep);
    return motionFindings(await inPage(page, collectMotion, SHORTEST_MS));
  },
};

// The findings, from what the page reported — `collectMotion` below.
export function motionFindings({ moving }) {
  if (moving.length === 0) return [];
  return [{
    rule: 'reduced-motion',
    title: 'Motion plays although reduced motion is asked for',
    impact: impactOf('reduced-motion'),
    count: moving.length,
    nodes: moving.slice(0, MAX_NODES).map(({ element, motions }) => ({
      ...element,
      explanation: motions.map(describeMotion).join('; '),
    })),
    detail: 'prefers-reduced-motion: reduce · WCAG 2.3.3 Animation from Interactions',
  }];
}

function describeMotion({ kind, name, properties, duration, forever }) {
  if (kind === 'scroll') return 'scrolls smoothly (scroll-behavior: smooth)';
  const how = forever ? 'forever' : `for ${Math.round(duration)}ms`;
  const what = properties.join(', ');
  if (kind === 'animation') return `animation “${name}” moves ${what} ${how}`;
  if (kind === 'transition') return `transition of ${what} ${how}`;
  return `script animation of ${what} ${how}`;
}

// --- in the page ----------------------------------------------------------------

// Installed before any of the page's scripts: keeps every animation the page
// starts, CSS or scripted, with the element it runs on.
export function watchMotion() {
  const seen = new Set();
  window[Symbol.for('kanso.motion')] = seen;

  const keep = (target, match) => {
    for (const animation of target.getAnimations?.() ?? []) if (match(animation)) seen.add(animation);
  };
  addEventListener('animationstart', (event) => keep(event.target, (a) => a.animationName === event.animationName), true);
  // `transitionrun` fires as a transition is created, before its delay: a
  // staggered reveal still counts when the sweep has moved on.
  addEventListener('transitionrun', (event) => keep(event.target, (a) => a.transitionProperty === event.propertyName), true);

  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    seen.add(animation);
    return animation;
  };
}

// Scrolls through the page a screen at a time, as a reader would, to set off
// what plays when it comes into view — then back to the top.
export async function sweep() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const step = Math.max(200, innerHeight * 0.8);
  const end = Math.min(document.documentElement.scrollHeight, step * 25);
  for (let y = step; y < end; y += step) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await frame();
    await frame();
  }
  // Three frames more, for what the last step set off: the observer's
  // callback, the class it adds, the transition that class starts.
  for (let i = 0; i < 3; i++) await frame();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Everything that moved, grouped by the element it moved.
export function collectMotion(dom, shortestMs) {
  const seen = window[Symbol.for('kanso.motion')] ?? new Set();
  // What was set off before the watch could hear it, or is still in its delay.
  for (const animation of document.getAnimations()) seen.add(animation);

  const MOVES = /^(transform|translate|rotate|scale|top|left|right|bottom|inset|margin|padding|width|height|min(Width|Height)|max(Width|Height)|backgroundPosition|offset(Path|Distance|Rotate)|perspective)/;
  const byElement = new Map();

  for (const animation of seen) {
    const effect = animation.effect;
    const target = effect?.target;
    if (!target?.isConnected) continue;

    const properties = new Set();
    for (const keyframe of effect.getKeyframes()) {
      for (const key of Object.keys(keyframe)) {
        if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key) && MOVES.test(key)) properties.add(key);
      }
    }
    if (properties.size === 0) continue;

    const timing = effect.getComputedTiming();
    const forever = timing.iterations === Infinity;
    const duration = forever ? timing.duration : timing.activeDuration;
    if (!forever && !(duration >= shortestMs)) continue;

    const kind = animation instanceof CSSAnimation ? 'animation' : animation instanceof CSSTransition ? 'transition' : 'script';
    const entry = byElement.get(target) ?? { element: dom.describe(target), motions: [] };
    entry.motions.push({
      kind,
      name: animation.animationName ?? '',
      properties: [...properties].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
      duration,
      forever,
    });
    byElement.set(target, entry);
  }

  const moving = [...byElement.values()];
  if (getComputedStyle(document.documentElement).scrollBehavior === 'smooth') {
    moving.push({ element: dom.describe(document.documentElement), motions: [{ kind: 'scroll' }] });
  }
  return { moving };
}
