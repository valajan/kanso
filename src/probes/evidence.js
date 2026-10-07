import { inPage } from './dom.js';

// The evidence of a finding: a picture of the part of the page its failing
// elements are in, each one boxed in red — and numbered, when there are
// several — so that whoever reads the report sees at once what failed, and an
// agent handed the file sees the same thing. Taken where the finding was made:
// in the page the probe read, in the state it read it in, right after the
// reading. Only for a load that keeps a journal (./journal.js), which is where
// the pictures go, as `evidence` events:
//
//   { kind: 'evidence', probe, at?, rule,
//     boxes: [{ n, path, selector, label?, explanation?, coveredBy?, rect }],
//     frame: { file, width, height, scale } }
//
// `rect` is in CSS pixels from the picture's top left corner, `frame` the
// picture's size in CSS pixels and the device pixels to each — the frames'
// own terms. The boxes are in the picture itself: nothing has to be drawn
// over it to read it.
//
// An element behind something else — a heading under an open menu, a link
// under a sticky header — is not what the picture shows at that place: its box
// is dashed, and `coveredBy` names what is over it (`dom.coveredBy`). A solid
// box over the menu would say the menu's entries are what failed. Only what
// is on the screen can be told covered: beyond it nobody asks, since asking
// would mean scrolling.
//
// The page is not scrolled, and nothing is added to it: the picture is taken
// beyond the viewport, as a full-page screenshot is, and the boxes are drawn
// on a canvas in a blank page of the annotator's own. A probe that goes on
// reading the page in its next state reads the page it would have read.
//
// A probe that knows the moment a finding shows takes the picture itself, then
// (`picture`): the keyboard walk, of a stop hidden behind a header while it
// has focus. That one is of the screen as it is — which scrolls nothing
// either —, kept if the reading reports the element, one picture for each
// thing that covers, and the finding is not pictured again afterwards.
//
// An element is found again by its path. One with none — inside a frame —,
// one that is gone, or one that takes no room on the page — a link in a menu
// the keyboard walk closed behind it — has no box; a finding none of whose
// elements has one has no picture, and is none the worse judged for it.

// How many elements of one finding are looked for, how many pictures they may
// make, and how many pictures a load may keep in all.
const MAX_ELEMENTS = 24;
const MAX_PICTURES = 6;
export const MAX_EVIDENCE = 60;
// How many pictures a probe may take of its own in one reading, before the
// reading says which of them it keeps.
const MAX_TAKEN = 12;

// How tall a picture may be, in CSS pixels, how wide, and the room left
// around what it shows.
const MAX_HEIGHT = 900;
const MAX_WIDTH = 1600;
const MARGIN = 120;

// A picture that does not come is a finding without one, not a stuck probe.
const TIMEOUT_MS = 5_000;
const QUALITY = 0.72;

// What makes the pictures of one load: a `reading(log)` for each reading of a
// page — as it loaded, in a state —, `close()` once the probes are done.
// `browser` is where the annotator opens its blank page, the first time a
// picture needs one. A reading has `picture(page, rule, element)`, for the
// probe to call while it reads — null when the load keeps nothing, so that a
// probe does no work for it —, and `collect(page, findings)` for what the
// reading found.
export function evidenceFor(browser) {
  let annotator = null;
  let kept = 0;

  const annotate = async (png, boxes, width) => {
    annotator ??= openAnnotator(browser);
    const { page } = await annotator;
    return page.evaluate(draw, { png: png.toString('base64'), boxes, width, quality: QUALITY });
  };

  // Draws `boxes` on `png`, a picture `size` CSS pixels, and keeps it.
  const keep = async (log, rule, png, boxes, size) => {
    const { jpeg, scale } = await annotate(png, boxes.map(({ n, rect, coveredBy }) => ({ n, ...rect, covered: Boolean(coveredBy) })), size.width);
    kept += 1;
    log.keep('evidence', {
      rule,
      boxes: boxes.map(({ n, path, selector, label, explanation, coveredBy, rect }) => ({
        n, path, selector, ...(label ? { label } : {}), ...(explanation ? { explanation } : {}), ...(coveredBy ? { coveredBy } : {}), rect,
      })),
    }, { jpeg: Buffer.from(jpeg, 'base64'), size: { ...size, scale } });
  };

  return {
    reading(log) {
      if (!log.recording) return IDLE;
      // What the probe pictured as it read: [{ rule, element, png, size }].
      const taken = [];

      return {
        // The screen as it is now, for `element` — described as a finding's
        // node is, with its `rect` on the screen and, when something is over
        // it, `coveredBy`. Never rejects.
        async picture(page, rule, element) {
          if (taken.length >= MAX_TAKEN || kept >= MAX_EVIDENCE) return;
          try {
            await withTimeout(async () => {
              const [png, size] = await Promise.all([
                page.screenshot({ type: 'png', timeout: TIMEOUT_MS }),
                page.evaluate('({ width: Math.round(visualViewport?.width ?? innerWidth), height: Math.round(visualViewport?.height ?? innerHeight) })'),
              ]);
              taken.push({ rule, element, png, size });
            }, TIMEOUT_MS * 2);
          } catch {
            // This moment goes without a picture.
          }
        },

        // Never rejects: evidence that cannot be taken costs the picture.
        async collect(page, findings) {
          for (const finding of findings) {
            if (kept >= MAX_EVIDENCE) return;
            try {
              if (await withTimeout(() => own(finding), TIMEOUT_MS * 3)) continue;
              await withTimeout(() => located(page, finding), TIMEOUT_MS * 3);
            } catch {
              // This finding goes without a picture.
            }
          }
        },
      };

      // The pictures the probe took of this finding's elements, one for each
      // thing that covers — eleven links behind one header are one picture.
      // Resolves to whether there was any.
      async function own(finding) {
        const shown = new Set();
        let any = false;
        for (const { rule, element, png, size } of taken) {
          if (rule !== finding.rule || shown.has(element.coveredBy ?? '')) continue;
          const index = finding.nodes.findIndex((node) => node.path && node.path === element.path);
          if (index < 0) continue;
          if (kept >= MAX_EVIDENCE || shown.size >= MAX_PICTURES) break;
          shown.add(element.coveredBy ?? '');
          await keep(log, rule, png, [{ ...finding.nodes[index], n: index + 1, coveredBy: element.coveredBy, rect: element.rect }], size);
          any = true;
        }
        return any;
      }

      // The finding's elements, found again on the page as it stands.
      async function located(page, finding) {
        const { viewport, document: size, found } = await inPage(page, locate, finding.nodes.slice(0, MAX_ELEMENTS).map(({ path }) => path ?? null));
        const elements = found.flatMap((where, i) => (where ? [{ ...finding.nodes[i], ...where }] : []));
        for (const picture of pictures(elements, { viewport, document: size }).slice(0, MAX_PICTURES)) {
          if (kept >= MAX_EVIDENCE) return;
          const png = await page.screenshot({ type: 'png', fullPage: true, clip: picture.clip, timeout: TIMEOUT_MS });
          await keep(log, finding.rule, png, picture.boxes, { width: picture.clip.width, height: picture.clip.height });
        }
      }
    },

    async close() {
      const opened = await annotator?.catch(() => null);
      await opened?.context.close().catch(() => {});
    },
  };
}

// The reading of a load nobody records: nothing to take, nothing to keep.
const IDLE = { picture: null, async collect() {} };

// The pictures `elements` — each with its `rect` on the page — are shown in:
// [{ clip, boxes: [{ n, ...element, rect }] }], `clip` the part of the page a
// picture covers and each `rect` moved to that picture's corner. Elements are
// numbered in the order the finding lists them, from 1, whatever picture they
// end up in; one finding's elements share its pictures from the top of the
// page down, as many to a picture as fit its height. An element taller than a
// picture is shown from its top.
export function pictures(elements, { viewport, document }) {
  const width = Math.min(MAX_WIDTH, Math.max(viewport.width, Math.min(document.width, Math.max(...elements.map(({ rect }) => rect.x + rect.width), 0))));
  const height = Math.min(MAX_HEIGHT, viewport.height, document.height);
  const numbered = elements.map((element, i) => ({ ...element, n: i + 1 })).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  const groups = [];
  for (const element of numbered) {
    const group = groups.at(-1);
    if (group && element.rect.y + Math.min(element.rect.height, height) - group[0].rect.y <= height - MARGIN) group.push(element);
    else groups.push([element]);
  }

  return groups.map((group) => {
    const top = Math.min(...group.map(({ rect }) => rect.y));
    const bottom = Math.min(top + height, Math.max(...group.map(({ rect }) => rect.y + rect.height)));
    // What is shown sits in the middle of its picture, the page's edges
    // allowing.
    const y = Math.round(Math.max(0, Math.min((top + bottom) / 2 - height / 2, document.height - height)));
    return {
      clip: { x: 0, y, width, height },
      boxes: group.map(({ rect, ...element }) => ({ ...element, rect: { x: rect.x, y: rect.y - y, width: rect.width, height: rect.height } })),
    };
  });
}

// --- in the page under audit --------------------------------------------------

// Where each of `paths` is on the page — `rect`, in CSS pixels from the
// document's top left corner, and `coveredBy` when it is on the screen behind
// something else; null for a path that leads nowhere, or to something that
// takes no room —, with the size of the viewport and of the document.
function locate(dom, paths) {
  const at = (path) => {
    const steps = path.split(',');
    let node = document;
    for (let i = 0; i < steps.length; i += 2) {
      let index = Number(steps[i]);
      let child = node.firstChild;
      for (; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE && !(child.nodeValue ?? '').trim()) continue;
        if (index === 0) break;
        index -= 1;
      }
      if (!child || child.nodeName !== steps[i + 1]) return null;
      node = child;
    }
    return node.nodeType === Node.ELEMENT_NODE ? node : null;
  };
  const shows = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  const root = document.documentElement;
  return {
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: Math.max(root.scrollWidth, innerWidth), height: Math.max(root.scrollHeight, innerHeight) },
    found: paths.map((path) => {
      const el = path ? at(path) : null;
      if (!el || !shows(el)) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const coveredBy = dom.coveredBy(el);
      return {
        rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
        ...(coveredBy ? { coveredBy } : {}),
      };
    }),
  };
}

// --- in the annotator's blank page -------------------------------------------

async function openAnnotator(browser) {
  const context = await browser.newContext();
  try {
    return { context, page: await context.newPage() };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// The picture with its boxes: `png` drawn on a canvas, each of `boxes` — in
// CSS pixels of a picture `width` of them wide — outlined in red over a white
// line that keeps it readable on a red page, dashed when it is `covered` —
// what shows there is what is over the element —, with its number in a corner
// when there are several. Resolves to { jpeg, scale }: the bytes in base 64, and
// the device pixels to a CSS pixel.
async function draw({ png, boxes, width, quality }) {
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const scale = image.naturalWidth / width;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const RED = '#e5001c';
  const line = 3 * scale;
  for (const { n, x, y, width: w, height: h, covered } of boxes) {
    // Around the element rather than over its edge, and inside the picture.
    const left = Math.max(line, (x - 3) * scale);
    const top = Math.max(line, (y - 3) * scale);
    const right = Math.min(canvas.width - line, (x + w + 3) * scale);
    const bottom = Math.min(canvas.height - line, (y + h + 3) * scale);
    if (right <= left || bottom <= top) continue;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = line * 2;
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.setLineDash(covered ? [line * 3, line * 2] : []);
    ctx.strokeStyle = RED;
    ctx.lineWidth = line;
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.setLineDash([]);

    if (boxes.length === 1) continue;
    const size = 13 * scale;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    const text = String(n);
    const badgeW = ctx.measureText(text).width + 10 * scale;
    const badgeH = size + 6 * scale;
    // Beside the box's top left corner, where it hides nothing of a box
    // stacked over this one; over the corner when the picture's edge is there.
    const beside = left - line / 2 - badgeW >= 0;
    const bx = beside ? left - line / 2 - badgeW : Math.max(0, Math.min(left - line / 2, canvas.width - badgeW));
    const by = beside ? top - line / 2 : Math.max(0, top - badgeH + line / 2);
    ctx.fillStyle = RED;
    ctx.fillRect(bx, by, badgeW, badgeH);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 5 * scale, by + badgeH / 2 + scale);
  }
  return { jpeg: canvas.toDataURL('image/jpeg', quality).split(',')[1], scale };
}

async function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('no evidence')), ms);
  });
  const running = work();
  running.catch(() => {});
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
