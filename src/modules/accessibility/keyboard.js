import { MAX_NODES } from '../findings.js';
import { inPage } from '../../probes/dom.js';
import { impactOf } from './rules.js';

// The page under a keyboard: Tab from the top, one stop at a time, until focus
// leaves the page — what someone who cannot use a mouse goes through, and what
// axe cannot, since it never presses a key. Three things are judged:
//
//   focus-trap      Tab goes round a set of elements and never leaves, or
//                   stays on one (WCAG 2.1.2) — outside an open modal dialog,
//                   which is where holding focus is the point
//   focus-visible   a stop shows no sign of having focus, or is out of sight
//                   when it has it: off the screen, sizeless, transparent
//                   (WCAG 2.4.7)
//   focus-obscured  a stop is entirely hidden, when focused, behind something
//                   else on the page — a sticky header, a cookie banner
//                   (WCAG 2.4.11)
//
// A sign of focus is anything that changes on the element, its ::before and
// ::after, its parent or its first children when it takes focus: an outline, a
// ring, a border, a background, an underline. The browser's own focus ring
// counts. Transitions are finished rather than waited for: what is compared is
// where they end.
const MAX_STOPS = 150;

export const keyboard = {
  id: 'keyboard',
  rules: ['focus-trap', 'focus-visible', 'focus-obscured'],

  async run(page, { log }) {
    // Focus the page placed itself — an autofocus, a dialog opening — is
    // where a keyboard user starts, and the first stop.
    const focused = await inPage(page, startWalk);
    if (focused) await inPage(page, recordStop);
    for (let i = 0; i < MAX_STOPS; i++) {
      await page.keyboard.press('Tab');
      if (await inPage(page, recordStop)) break;
    }
    const walk = await inPage(page, endWalk);
    // Every stop, in the order Tab reached it: the walk as a keyboard user
    // made it, whether or not anything was found on the way.
    walk.stops.forEach((stop, index) => log.log('tab-stop', {
      index,
      path: stop.element.path,
      selector: stop.element.selector,
      label: stop.element.label,
      indicator: stop.indicator,
      ...(stop.hidden ? { hidden: stop.hidden } : {}),
      ...(stop.coveredBy ? { coveredBy: stop.coveredBy } : {}),
    }));
    log.log('tab-end', { end: walk.end, stops: walk.stops.length });
    return keyboardFindings(walk);
  },
};

// The findings, from what the walk recorded — `endWalk` below.
export function keyboardFindings({ stops, trap }) {
  const findings = [];

  if (trap) {
    findings.push({
      rule: 'focus-trap',
      title: 'Keyboard focus cannot leave part of the page',
      impact: impactOf('focus-trap'),
      count: 1,
      nodes: [{
        ...trap.element,
        explanation: trap.kind === 'stuck'
          ? 'Tab leaves focus on this element'
          : `Tab goes round ${trap.size} element${trap.size === 1 ? '' : 's'} and back to this one, never leaving the page`,
      }],
      detail: 'WCAG 2.1.2 No Keyboard Trap',
    });
  }

  const unseen = stops.filter((stop) => stop.hidden || !stop.indicator);
  if (unseen.length > 0) {
    findings.push({
      rule: 'focus-visible',
      title: 'Keyboard focus is not visible',
      impact: impactOf('focus-visible'),
      count: unseen.length,
      nodes: unseen.slice(0, MAX_NODES).map((stop) => ({
        ...stop.element,
        explanation: stop.hidden ? `focused while ${stop.hidden}` : 'focused with no visible change',
      })),
      detail: 'WCAG 2.4.7 Focus Visible',
    });
  }

  const covered = stops.filter((stop) => !stop.hidden && stop.coveredBy);
  if (covered.length > 0) {
    findings.push({
      rule: 'focus-obscured',
      title: 'Keyboard focus is hidden behind other content',
      impact: impactOf('focus-obscured'),
      count: covered.length,
      nodes: covered.slice(0, MAX_NODES).map((stop) => ({
        ...stop.element,
        explanation: `entirely behind ${stop.coveredBy} when focused`,
      })),
      detail: 'WCAG 2.4.11 Focus Not Obscured',
    });
  }

  return findings;
}

// --- in the page ----------------------------------------------------------------
//
// Sent to the page as source (src/probes/dom.js), one call per step. What the
// walk has seen lives in the page between two calls, under a symbol no page
// script uses — with the two helpers every step needs, which only exist there
// if a step defines them.

// Starts at the top, from wherever the page put focus. Resolves to true when
// that is somewhere.
function startWalk() {
  const walk = { stops: [], repeats: 0, end: null };
  window[Symbol.for('kanso.keyboard')] = walk;

  // Transitions run to their end at once: what is compared is where they land.
  walk.settle = () => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
    }
  };

  // What focus could change on an element: its own styles and its pseudo
  // elements', its first three ancestors' (`:focus-within`, a card lit up
  // around its link), its first children's. One string per box, compared as a
  // whole.
  walk.signs = (element) => {
    const ancestors = [];
    for (let node = element.parentElement; node && node !== document.body && ancestors.length < 3; node = node.parentElement) ancestors.push([node]);
    const boxes = [[element], [element, '::before'], [element, '::after'], ...ancestors,
      ...[...element.children].slice(0, 5).map((child) => [child])];
    return boxes.map(([node, pseudo]) => {
      if (!node) return '';
      const css = getComputedStyle(node, pseudo);
      // An outline shows only with a style, a width and a colour.
      const outline = css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0 && !/rgba\(.*, 0\)$|transparent/.test(css.outlineColor)
        ? `${css.outlineStyle} ${css.outlineWidth} ${css.outlineColor} ${css.outlineOffset}`
        : 'none';
      return [
        outline, css.boxShadow,
        css.borderTopColor, css.borderRightColor, css.borderBottomColor, css.borderLeftColor,
        css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth,
        css.backgroundColor, css.backgroundImage, css.color,
        css.textDecorationLine, css.textDecorationColor, css.textDecorationThickness,
        css.opacity, css.transform, css.filter, css.fill, css.stroke,
        pseudo ? css.content : '',
      ].join('|');
    });
  };

  window.scrollTo(0, 0);
  return document.activeElement != null && document.activeElement !== document.body;
}

// Records where one Tab press left focus. Resolves to true when the walk is
// over: focus left the page, came back round, or stopped moving.
function recordStop() {
  const walk = window[Symbol.for('kanso.keyboard')];

  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element || element === document.body || element === document.documentElement) {
    walk.end = { kind: 'left' };
    return true;
  }

  const seen = walk.stops.findIndex((stop) => stop.element === element);
  if (seen >= 0 && seen === walk.stops.length - 1) {
    // Focus inside a frame is the frame, to this document: Tab moves on in
    // there, out of sight, until it comes back out.
    if (element.localName === 'iframe') return false;
    walk.repeats += 1;
    if (walk.repeats < 2) return false;
    walk.end = { kind: 'stuck', index: seen };
    return true;
  }
  if (seen >= 0) {
    walk.end = { kind: 'cycle', index: seen };
    return true;
  }

  walk.repeats = 0;
  walk.settle();
  walk.stops.push({ element, focused: walk.signs(element), hidden: hiddenReason(element), coveredBy: coverOf(element) });
  return false;

  // Why an element with focus cannot be seen, or null when it can.
  function hiddenReason(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return 'it has no size';
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 'it is invisible';
    // Less than a pixel of it shows: nothing does.
    const shows = (clip) => Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left) > 1
      && Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top) > 1;
    if (!shows({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })) return 'it is off the screen';
    // Out of a box that hides its overflow and could not scroll to it: the
    // entry of a menu folded to no height, a slide clipped out of sight.
    for (let box = node.parentElement; box && box !== document.body; box = box.parentElement) {
      const css = getComputedStyle(box);
      if (css.overflowX === 'visible' && css.overflowY === 'visible') continue;
      if (!shows(box.getBoundingClientRect())) return 'it is outside the visible part of its container';
    }
    return null;
  }

  // What entirely hides a focused element, as a short selector, or null.
  // Sampled at its centre and near its corners, inside the screen: hidden at
  // every point is hidden.
  function coverOf(node) {
    const rect = node.getBoundingClientRect();
    const inset = Math.min(2, rect.width / 4, rect.height / 4);
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    if (points.length === 0) return null;

    let cover = null;
    for (const [x, y] of points) {
      const top = document.elementFromPoint(x, y);
      if (!top || top === node || node.contains(top) || top.contains(node)) return null;
      cover ??= top;
    }
    // Named by the outermost element that covers it: the header, not its logo.
    let outer = cover;
    while (outer.parentElement && outer.parentElement !== document.body && !outer.parentElement.contains(node)) outer = outer.parentElement;
    const id = outer.id ? `#${outer.id}` : outer.classList.length > 0 ? `.${outer.classList[0]}` : '';
    return outer.localName + id;
  }
}

// Ends the walk: takes focus away, reads every stop again without it, and
// says what changed — and what the walk ended on.
function endWalk(dom) {
  const walk = window[Symbol.for('kanso.keyboard')];
  document.activeElement?.blur?.();
  walk.settle();

  const stops = walk.stops.map((stop) => {
    const unfocused = walk.signs(stop.element);
    return {
      element: dom.describe(stop.element),
      indicator: unfocused.some((sign, i) => sign !== stop.focused[i]),
      hidden: stop.hidden,
      coveredBy: stop.coveredBy,
    };
  });

  let trap = null;
  const { end } = walk;
  if (end?.kind === 'stuck') {
    trap = { kind: 'stuck', element: stops[end.index].element };
  } else if (end?.kind === 'cycle') {
    // Holding focus is what an open modal dialog is for.
    const loop = walk.stops.slice(end.index).map((stop) => stop.element);
    const modal = loop[0].closest('dialog:modal, [aria-modal="true"]');
    if (!modal || !loop.every((element) => modal.contains(element))) {
      trap = { kind: 'cycle', size: loop.length, element: stops[end.index].element };
    }
  }

  return { stops, trap, end: end?.kind ?? 'limit' };
}
