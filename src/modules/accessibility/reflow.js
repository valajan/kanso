import { MAX_NODES } from '../findings.js';
import { inPage } from '../../probes/dom.js';
import { impactOf } from './rules.js';

// WCAG 1.4.10, Reflow: at 320 CSS pixels wide, content fits without scrolling
// sideways, and none of it is lost. It is what a 1280 px window zoomed to 400%
// shows, and what axe cannot check — it runs at one width, and the width is
// the whole question.
//
// The probe lays the page out at 320 px and reports two things:
//
//   reflow-scroll  the page scrolls sideways, and the elements that make it
//   reflow-clip    it does not, but text runs past an edge that cuts it —
//                  an `overflow: hidden` box, or the screen itself — and
//                  cannot be scrolled to
//
// What WCAG lets need two dimensions — images, video, maps, data tables — is
// left out, as is a region the reader can scroll on its own: a code block
// with a scrollbar reflows as it should.
export const VIEWPORT_WIDTH = 320;

export const reflow = {
  id: 'reflow',
  rules: ['reflow-scroll', 'reflow-clip'],
  // 320 px is a width, not a device: one layout serves both form factors, and
  // the mobile load is the one that runs it.
  formFactors: ['mobile'],
  // Laid out as a zoomed desktop window rather than a phone: a phone lays out a
  // page that asks for a wider viewport at that width, then shrinks it — which
  // is how a page fails to reflow without ever scrolling. Portrait, so that no
  // `orientation: landscape` rule applies.
  viewport: { width: VIEWPORT_WIDTH, height: 640, deviceScaleFactor: 1, isMobile: false, hasTouch: false },

  async run(page) {
    return reflowFindings(await inPage(page, measureReflow));
  },
};

// The findings, from what the page reported of itself — `measureReflow` below.
export function reflowFindings({ viewport, scrolls, culprits, clipped }) {
  const findings = [];

  if (scrolls && culprits.length > 0) {
    findings.push({
      rule: 'reflow-scroll',
      title: `Page scrolls sideways at ${viewport} CSS pixels wide`,
      impact: impactOf('reflow-scroll'),
      count: culprits.length,
      nodes: culprits.slice(0, MAX_NODES).map(({ element, width, text, past, side }) => ({
        ...element,
        explanation: text == null
          ? `${width}px wide, ${past}px past the ${side} edge of the ${viewport}px viewport`
          : `its text runs ${past}px past the ${side} edge of the ${viewport}px viewport: “${text}”`,
      })),
      detail: 'WCAG 1.4.10 Reflow',
    });
  }

  if (clipped.length > 0) {
    findings.push({
      rule: 'reflow-clip',
      title: `Text is cut off at ${viewport} CSS pixels wide`,
      impact: impactOf('reflow-clip'),
      count: clipped.length,
      nodes: clipped.slice(0, MAX_NODES).map(({ element, text, past, side, by }) => ({
        ...element,
        explanation: by === 'viewport'
          ? `“${text}” runs ${past}px past the ${side} edge of the screen, out of reach`
          : `cuts off “${text}”, ${past}px past its ${side} edge`,
      })),
      detail: 'WCAG 1.4.10 Reflow',
    });
  }

  return findings;
}

// Runs in the page, laid out at the probe's width. Returns
// { viewport, scrolls, culprits, clipped }:
//
// - culprits  what makes the page scroll: the outermost elements past the edge
//             it scrolls towards — their descendants go with them — and the
//             boxes whose text runs past it, a `<pre>` that neither wraps nor
//             scrolls
// - clipped   one entry per element that cuts text off: the box that hides it
//             or, when the screen does, the outermost element carrying the
//             text past it
//
// Sent to the page as source (src/probes/dom.js): nothing outside it is in
// scope there.
export async function measureReflow(dom) {
  await document.fonts?.ready;

  const root = document.documentElement;
  const body = document.body;
  const viewport = root.clientWidth;
  const style = (element) => getComputedStyle(element);
  const rtl = style(root).direction === 'rtl';
  // A document scrolls towards its end — right, left to right. What sticks out
  // the other way is out of reach.
  const end = rtl ? 'left' : 'right';
  const pastEnd = (rect) => (rtl ? -rect.left : rect.right - viewport);
  const past = (rect, box) => Math.max(rect.right - box.right, box.left - rect.left);
  const screen = { left: 0, right: viewport };

  // The screen hides sideways overflow when the root says so, or the body does
  // and CSS hands it to the screen: the content is there, and out of reach.
  const clips = (css) => css.overflowX === 'hidden' || css.overflowX === 'clip';
  const rootCss = style(root);
  const screenClips = clips(rootCss) || (rootCss.overflowX === 'visible' && clips(style(body)));
  const scrolls = root.scrollWidth > viewport + 1 && !screenClips;

  // What may need two dimensions (WCAG's exceptions), and whatever it holds.
  const TWO_DIMENSIONAL = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'svg', 'iframe', 'object', 'embed', 'map', 'table']);

  // --- boxes past the end -------------------------------------------------------
  const culprits = new Map();
  const visit = (element) => {
    const css = style(element);
    // A fixed element is laid out against the screen and makes nothing scroll;
    // what hides or scrolls its own overflow keeps it to itself.
    if (css.display === 'none' || css.position === 'fixed' || TWO_DIMENSIONAL.has(element.localName)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && pastEnd(rect) > 1) {
      culprits.set(element, { element: dom.describe(element), width: Math.round(rect.width), past: Math.round(pastEnd(rect)), side: end });
      return;
    }
    if (element !== body && (clips(css) || css.overflowX === 'auto' || css.overflowX === 'scroll')) return;
    for (const child of element.children) visit(child);
  };
  if (scrolls) visit(body);
  const withinCulprit = (element) => {
    for (let node = element; node; node = node.parentElement) if (culprits.has(node)) return true;
    return false;
  };

  // --- what cuts text, element by element ---------------------------------------

  // The box that cuts an element's text sideways: the nearest ancestor hiding
  // its overflow, or the screen — for a fixed element, or when the screen
  // clips. null when the cut is deliberate or harmless: an ellipsis, a line
  // clamp, a region that scrolls, a visually hidden box a pixel wide, anything
  // that may need two dimensions. At the top, `reachable`: the page scrolls
  // towards its end, so only the other side is out of reach.
  const top = screenClips
    ? { box: screen }
    : { reachable: true, box: rtl ? { left: -Infinity, right: viewport } : { left: 0, right: Infinity } };
  const known = new Map();
  const clipperOf = (element) => {
    if (!element || element === body || element === root) return top;
    if (known.has(element)) return known.get(element);
    const css = style(element);
    let clipper;
    if (TWO_DIMENSIONAL.has(element.localName) || css.overflowX === 'auto' || css.overflowX === 'scroll') {
      clipper = null;
    } else if (clips(css)) {
      const clamped = css.webkitLineClamp && css.webkitLineClamp !== 'none';
      if (css.textOverflow === 'ellipsis' || clamped || element.clientWidth <= 1 || element.clientHeight <= 1) {
        clipper = null;
      } else {
        const rect = element.getBoundingClientRect();
        const left = rect.left + element.clientLeft;
        clipper = { element, box: { left, right: left + element.clientWidth } };
      }
    } else if (css.position === 'fixed') {
      clipper = { box: screen, fixed: element };
    } else {
      clipper = clipperOf(element.parentElement);
    }
    known.set(element, clipper);
    return clipper;
  };

  // Where to point: for text the screen cuts, the outermost element still past
  // its edge; for text that makes the page scroll, the box it runs out of.
  const outermostPast = (element) => {
    let found = element;
    for (let node = element.parentElement; node && node !== body; node = node.parentElement) {
      if (past(node.getBoundingClientRect(), screen) > 1) found = node;
    }
    return found;
  };
  const boxRunOutOf = (element) => {
    let node = element;
    while (node.parentElement && node.parentElement !== body && pastEnd(node.getBoundingClientRect()) > 1) node = node.parentElement;
    return node;
  };

  const excerpt = (text) => {
    const words = text.replace(/\s+/g, ' ').trim();
    return words.length > 40 ? words.slice(0, 39) + '…' : words;
  };

  const cut = new Map();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const text = walker.currentNode;
    const parent = text.parentElement;
    if (!text.nodeValue.trim() || !parent) continue;
    if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;

    range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) continue;
    const extent = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };

    const clipper = clipperOf(parent);
    if (!clipper) continue;

    // Text the page scrolls to: one more reason it scrolls, unless a box
    // already said so.
    if (clipper.reachable && pastEnd(extent) > 1) {
      if (!scrolls || withinCulprit(parent)) continue;
      const box = boxRunOutOf(parent);
      const over = Math.round(pastEnd(extent));
      if ((culprits.get(box)?.past ?? 0) >= over) continue;
      culprits.set(box, { element: dom.describe(box), text: excerpt(text.nodeValue), past: over, side: end });
      continue;
    }

    const { box } = clipper;
    const over = past(extent, box);
    if (over <= 1) continue;
    // Wholly outside is hidden on purpose — the other slides of a carousel, a
    // menu waiting off the screen — rather than cut. Except in a fixed bar
    // that is itself on the screen: a link pushed past its end is lost there.
    // A pixel of slack, for percentages that do not land on whole pixels.
    const outside = (rect) => rect.left >= box.right - 1 || rect.right <= box.left + 1;
    if (outside(extent) && !(clipper.fixed && !outside(clipper.fixed.getBoundingClientRect()))) continue;

    const owner = clipper.element ?? outermostPast(parent);
    if ((cut.get(owner)?.past ?? 0) >= over) continue;
    cut.set(owner, {
      element: dom.describe(owner),
      text: excerpt(text.nodeValue),
      past: Math.round(over),
      side: extent.right - box.right >= box.left - extent.left ? 'right' : 'left',
      by: clipper.element ? 'element' : 'viewport',
    });
  }

  return { viewport, scrolls, culprits: [...culprits.values()], clipped: [...cut.values()] };
}
