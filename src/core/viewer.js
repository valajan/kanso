// The page a record opens in: `index.html`, beside the journals and audit.json
// in the directory a record is kept in (src/core/record.js). The findings of the
// audit; for the one selected, the moments of the journals that produced it —
// the page loaded, the state reached, the way in and out — with their frames
// and the boxes the events name drawn over them; and each load's events, in
// order.
//
// One file, and nothing else: no request, no CDN, no server. It is opened from
// the disk, where a page may not fetch the files beside it, so everything it
// shows is inside it — the journals, the result, the frames as data URIs.
// Kanso hosts nothing, and this is no exception.
//
// A finding can be exported from it as a page of its own, holding that
// finding's moments and frames and nothing else — what one attaches to an
// issue. The page makes it in the browser, from its own style, its own script
// and the part of its data the finding needs: which is why what joins a
// finding to its moments is written here as plain functions, sent into the
// page as source (as src/probes/dom.js sends what runs in a page under audit),
// and run by the tests in Node as they are.

// The data a page shows: the findings of the result, one list for every
// module; the probes that failed; each load's journal; the frames by the path
// the events name them with.
//
//   { kind: 'record' | 'extract', url, baseline, conclusion,
//     findings: [{ key, module, ...finding }], failures: [{ module, probe, at?, error }],
//     loads: [{ name, side, formFactor, run, events }], frames: { [file]: dataUri } }
export function viewerData({ result, loads = [], frames = {} }) {
  const modules = Object.entries(result?.modules ?? {});
  const findings = modules.flatMap(([module, { findings }]) => (findings ?? []).map((finding) => ({ module, ...finding })))
    .map((finding, i) => ({ key: `f${i}`, ...finding }));
  const failures = modules.flatMap(([module, { probeFailures }]) => (probeFailures ?? []).map((failure) => ({ module, ...failure })));
  return {
    kind: 'record',
    url: result?.url ?? null,
    baseline: result?.baseline ?? null,
    conclusion: result?.conclusion ?? null,
    findings,
    failures,
    loads,
    frames,
  };
}

// The page, with `data` inside it.
export function renderViewer(data) {
  return pageHtml({ css: CSS, script: SCRIPT, data });
}

// --- sent into the page ---------------------------------------------------------
//
// Everything below the CSS travels as source, into the page, and is run there
// as it is here: nothing it uses may come from this module but the other
// functions sent with it.

// The moments of one load's journal that produced `finding`. A finding is found
// again by its `finding` event: the same rule, in the same state, on one of the
// same elements. That event names the probe, and the moments are that probe's
// way through the state the finding was made in — the page it loaded, the
// state reached, the way in and out, the focus read after —, the Tab stops on
// its elements, and the finding itself. Only the page under audit, on a form
// factor it was found on: the baseline's journals explain the baseline.
//
// An element is the same one by its path when both sides have one; the
// result's elements have lost theirs — folded across form factors
// (src/modules/findings.js) — and are the same one by their selector.
//
// A finding no probe made — one of Lighthouse's own audits — has no moment.
export function momentsOf(finding, load) {
  if (load.side !== 'current' || !(finding.formFactors ?? []).includes(load.formFactor)) return [];
  const at = finding.at ?? null;
  const nodes = finding.nodes ?? [];
  const sameNode = (a, b) => (a.path && b.path ? a.path === b.path : a.selector === b.selector);
  const ours = (element) => nodes.some((node) => sameNode(node, element));
  const same = (event) => (event.at ?? null) === at;
  const isIt = (event) => event.kind === 'finding' && event.rule === finding.rule && same(event)
    && (nodes.length === 0 || (event.nodes ?? []).length === 0 || event.nodes.some(ours));
  const probes = new Set(load.events.filter(isIt).map((event) => event.probe));
  return load.events.filter((event) => {
    if (!probes.has(event.probe)) return false;
    if (event.kind === 'finding') return isIt(event);
    if (event.kind === 'tab-stop') return same(event) && ours(event);
    if (['probe-start', 'probe-end', 'probe-failed'].includes(event.kind)) return false;
    return same(event) || (event.kind === 'loaded' && event.at == null);
  });
}

// `data` cut down to one finding: its moments in each load that has any, the
// frames they show, and nothing else of the record.
export function extractOf(data, key) {
  const finding = data.findings.find((candidate) => candidate.key === key);
  const loads = data.loads
    .map((load) => ({ ...load, events: momentsOf(finding, load) }))
    .filter((load) => load.events.length > 0);
  const frames = {};
  for (const load of loads) {
    for (const event of load.events) {
      if (event.frame && data.frames[event.frame.file]) frames[event.frame.file] = data.frames[event.frame.file];
    }
  }
  return { ...data, kind: 'extract', findings: [finding], failures: [], loads, frames };
}

// JSON that can sit inside a <script> element: no `<` in it, so neither a
// closing tag nor a comment opener can end the element early.
export function jsonIn(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The whole page, from its style, its script and its data. The script tags
// are spelled in two halves: this function travels inside a <script> too.
export function pageHtml({ css, script, data }) {
  const close = (tag) => '<' + '/' + tag + '>';
  const title = data.kind === 'extract'
    ? `Kanso · ${data.findings[0].rule}${data.findings[0].at ? ' @ ' + data.findings[0].at : ''}`
    : 'Kanso record';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + esc(title) + close('title'),
    '<style id="kanso-style">' + css + close('style'),
    close('head'),
    '<body>',
    '<main id="kanso"><p class="muted">This page needs JavaScript to show the record.' + close('p') + close('main'),
    '<' + 'script type="application/json" id="kanso-data">' + jsonIn(data) + close('script'),
    '<' + 'script id="kanso-app">' + script + close('script'),
    close('body'),
    close('html'),
    '',
  ].join('\n');
}

// What an event says, in a line.
export function describeEvent(event) {
  const where = (element) => (element ? element.selector : 'nowhere');
  switch (event.kind) {
    case 'load': return `${event.side} page, ${event.formFactor}, run ${event.run} — ${event.url}`;
    case 'lighthouse-start': return `Lighthouse: ${(event.categories ?? []).join(', ') || 'no category'}`;
    case 'lighthouse-end': return `Lighthouse done — ${event.finalUrl ?? ''}`;
    case 'probe-start': return `${event.module} probe starts${event.states?.length ? ` — states: ${event.states.join(', ')}` : ''}`;
    case 'loaded': return `page loaded, ${event.viewport?.width ?? '?'}×${event.viewport?.height ?? '?'}${event.media ? ' — ' + event.media.map((m) => `${m.name}: ${m.value}`).join(', ') : ''}`;
    case 'state-reached': return `state reached — clicked ${event.click}${event.waitFor ? `, ${event.waitFor} showed` : ''} (${event.ms} ms)`;
    case 'state-unreached': return `state not reached — ${event.error}`;
    case 'open': return `opened by ${event.by}: ${event.opened === true ? 'open' : event.opened === false ? 'did not open' : 'cannot tell'}${event.what ? ` — ${event.what}` : ''}${event.key ? ` (${event.key})` : ''}${event.focusable === false ? ' — trigger takes no focus' : ''}`;
    case 'close': return `closed by ${event.by}: ${event.closed === true ? 'closed' : event.closed === false ? 'still open' : 'cannot tell'}${event.reason ? ` — ${event.reason}` : ''}`;
    case 'focus': return `focus ${event.why ?? ''}: ${event.lost ? 'lost — on the body' : where(event)}`;
    case 'tab-stop': return `Tab stop ${event.index}: ${event.selector}${event.indicator ? ` — ${typeof event.indicator === 'string' ? event.indicator : JSON.stringify(event.indicator)}` : ''}${event.hidden ? ` — hidden: ${event.hidden}` : ''}${event.coveredBy ? ` — covered by ${event.coveredBy}` : ''}`;
    case 'tab-end': return `Tab walk ends: ${event.end} after ${event.stops} stops`;
    case 'finding': return `${event.rule}${event.impact ? ` (${event.impact})` : ''} on ${event.count} — ${(event.nodes ?? []).map((node) => node.selector).join(', ')}`;
    case 'probe-end': return `probe done in ${event.ms} ms — ${event.findings} finding${event.findings === 1 ? '' : 's'}${event.unreached ? `, not reached: ${event.unreached.join(', ')}` : ''}`;
    case 'probe-failed': return `probe failed — ${event.error}`;
    case 'transition-failed': return `transition failed — ${event.error}`;
    case 'load-end': return event.ok ? 'load done' : `load failed — ${event.error}`;
    default: {
      const { seq, t, kind, probe, at, frame, ...rest } = event;
      const text = JSON.stringify(rest);
      return text === '{}' ? '' : text.length > 160 ? text.slice(0, 159) + '…' : text;
    }
  }
}

// The page itself: reads its data, draws it, and makes the extracts.
function main(data) {
  const root = document.getElementById('kanso');
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (name === 'class') el.className = value;
      else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) el.append(child);
    return el;
  };
  const loadName = (load) => `${load.side} · ${load.formFactor} · run ${load.run}`;
  const chip = (text, cls = '') => h('span', { class: `chip ${cls}` }, text);

  // A frame, and over it the boxes of the events that follow it before the
  // next frame: the focus read after a transition, where it landed. A box is in
  // CSS pixels of the viewport, the picture in device pixels: both are placed
  // as fractions of the viewport's size, which the frame carries, and the
  // device pixel ratio drops out.
  const frameCard = (event, load) => {
    const src = data.frames[event.frame.file];
    const { width, height } = event.frame;
    const shot = h('div', { class: 'shot', style: `aspect-ratio: ${width} / ${height}` },
      src ? h('img', { src, alt: `The page at ${event.kind}`, loading: 'lazy' }) : h('p', { class: 'muted missing' }, 'frame missing'));
    const notes = h('ul', { class: 'notes' });
    const card = h('figure', { class: `frame ${height > width ? 'tall' : 'wide'}` }, shot,
      h('figcaption', {}, h('strong', {}, event.kind), ' ', meta(event, load), h('div', {}, describeEvent(event)), notes));
    card.box = (other, hit) => {
      const r = other.rect;
      if (r && r.width > 0 && r.height > 0) {
        const pct = (v, of) => `${(v / of) * 100}%`;
        shot.append(h('div', {
          class: `box ${hit ? 'hit' : ''}`,
          style: `left:${pct(r.x, width)};top:${pct(r.y, height)};width:${pct(r.width, width)};height:${pct(r.height, height)}`,
          title: describeEvent(other),
        }));
      }
      notes.append(h('li', {}, h('span', { class: `swatch ${hit ? 'hit' : ''}` }), describeEvent(other)));
    };
    return card;
  };

  const meta = (event, load) => h('span', { class: 'meta' },
    `+${event.t} ms`, event.probe ? ` · ${event.probe}` : '', event.at ? ` · @${event.at}` : '', load ? ` · ${load.formFactor}` : '');

  // A list of events, frames as cards and the rest as lines, the boxes drawn
  // on the frame before them. `hits` are the selectors to mark as the
  // finding's.
  const sequence = (events, load, hits = new Set()) => {
    const out = h('div', { class: 'sequence' });
    let last = null;
    for (const event of events) {
      if (event.frame) {
        last = frameCard(event, load);
        out.append(last);
      } else if (event.rect && last) {
        last.box(event, hits.has(event.selector));
      } else {
        out.append(h('p', { class: `line ${event.kind === 'finding' ? 'finding-line' : ''}` }, meta(event, null), ' ', h('strong', {}, event.kind), ' ', describeEvent(event)));
      }
    }
    return out;
  };

  const LEVELS = { fail: 0, warn: 1, pass: 2 };
  let selected = null;

  const header = h('header', {},
    h('h1', {}, data.kind === 'extract' ? 'Kanso — one finding' : 'Kanso record'),
    h('p', { class: 'target' }, h('span', { class: 'muted' }, 'page '), h('code', {}, data.url ?? '?'),
      data.baseline ? [h('span', { class: 'muted' }, ' against '), h('code', {}, data.baseline)] : null,
      data.conclusion ? [' ', chip(data.conclusion, data.conclusion)] : null));

  const list = h('ol', { class: 'findings' });
  const detail = h('section', { class: 'detail', 'aria-live': 'polite' });

  const findings = [...data.findings].sort((a, b) => (LEVELS[a.level] ?? 3) - (LEVELS[b.level] ?? 3));
  for (const finding of findings) {
    const button = h('button', { type: 'button', class: 'finding', 'aria-pressed': 'false', onclick: () => select(finding, button) },
      h('span', { class: 'row' }, chip(finding.level ?? '—', finding.level), h('strong', {}, finding.rule), finding.at ? chip('@' + finding.at, 'state') : null),
      h('span', { class: 'sub' }, [finding.impact, finding.needsReview ? 'needs review' : null, finding.count > 0 ? `${finding.count} element${finding.count === 1 ? '' : 's'}` : null, (finding.formFactors ?? []).join(' + '), finding.module, finding.state].filter(Boolean).join(' · ')));
    list.append(h('li', {}, button));
  }
  if (findings.length === 0) list.append(h('li', { class: 'muted' }, 'No findings.'));

  function select(finding, button) {
    selected = finding;
    for (const other of list.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
    detail.replaceChildren(...findingDetail(finding));
    if (window.matchMedia('(max-width: 899px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function findingDetail(finding) {
    const hits = new Set((finding.nodes ?? []).map((node) => node.selector));
    const parts = [
      h('h2', {}, finding.title ?? finding.rule),
      h('p', {}, chip(finding.level ?? '—', finding.level), ' ', h('code', {}, finding.rule), finding.at ? [' in state ', h('code', {}, finding.at)] : ' as the page loads',
        finding.impact ? ` · ${finding.impact}` : '', finding.state ? ` · ${finding.state}` : ''),
      finding.detail ? h('p', { class: 'muted' }, finding.detail) : null,
      h('ul', { class: 'nodes' }, (finding.nodes ?? []).map((node) => h('li', {}, h('code', {}, node.selector ?? node.url ?? '?'), node.label ? h('span', { class: 'muted' }, ` “${node.label}”`) : null, node.explanation ? h('div', {}, node.explanation) : null))),
    ];
    if (data.kind !== 'extract') {
      parts.push(h('p', {}, h('button', { type: 'button', class: 'export', onclick: () => exportFinding(finding) }, 'Export this finding as a page')));
    }
    const loads = data.loads.map((load) => ({ load, moments: momentsOf(finding, load) })).filter(({ moments }) => moments.length > 0);
    parts.push(h('h3', {}, 'How it was found'));
    if (loads.length === 0) {
      parts.push(h('p', { class: 'muted' }, 'No journal moment for it: it comes from one of Lighthouse’s own audits, not from a probe of Kanso’s.'));
    }
    for (const { load, moments } of loads) {
      parts.push(h('h4', {}, loadName(load)), sequence(moments, load, hits));
    }
    return parts;
  }

  function exportFinding(finding) {
    const html = pageHtml({
      css: document.getElementById('kanso-style').textContent,
      script: document.getElementById('kanso-app').textContent,
      data: extractOf(data, finding.key),
    });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = h('a', { href: url, download: `kanso-${finding.rule}${finding.at ? '@' + finding.at : ''}.html` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // Each load's events, in order — drawn when opened, the frames with them.
  const timeline = h('section', { class: 'timeline' }, h('h2', {}, data.kind === 'extract' ? 'The moments, load by load' : 'Every load, event by event'));
  for (const load of data.loads) {
    const frames = load.events.filter((event) => event.frame).length;
    const box = h('details', {}, h('summary', {}, loadName(load), h('span', { class: 'muted' }, ` — ${load.events.length} events, ${frames} frame${frames === 1 ? '' : 's'}`)));
    box.addEventListener('toggle', () => {
      if (box.open && !box.drawn) {
        box.drawn = true;
        box.append(sequence(load.events, load));
      }
    });
    timeline.append(box);
  }
  if (data.loads.length === 0) timeline.append(h('p', { class: 'muted' }, 'No journal was kept.'));

  const failures = data.failures.length > 0
    ? h('section', {}, h('h2', {}, 'Not checked'), h('ul', {}, data.failures.map((f) => h('li', {}, h('code', {}, `${f.module}/${f.probe}`), f.at ? ` @${f.at}` : '', ` — ${f.error}`))))
    : null;

  root.replaceChildren(header,
    h('div', { class: 'layout' },
      h('nav', { 'aria-label': 'Findings' }, h('h2', {}, `Findings (${findings.length})`), list),
      detail),
    ...(failures ? [failures] : []), timeline);

  if (findings.length > 0) select(findings[0], list.querySelector('button'));
}

const CSS = `
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --card: #fff;
  --fail: #b3261e; --warn: #8a5a00; --pass: #1f6f43; --accent: #2456a6; --box: #2456a6; --hit: #d0342c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --fg: #ecebe6; --muted: #a09f98; --line: #34332f; --card: #1f1f1d;
    --fail: #f28b82; --warn: #f2c46d; --pass: #81c995; --accent: #8ab4f8; --box: #8ab4f8; --hit: #ff7a70; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
h3 { font-size: .95rem; margin: 1.25rem 0 .5rem; }
h4 { font-size: .85rem; margin: 1rem 0 .5rem; color: var(--muted); font-weight: 600; }
code { font: .85em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.muted, .meta, .sub { color: var(--muted); }
.meta, .sub { font-size: .8rem; }
.target { margin: 0; overflow-wrap: anywhere; }
.chip { display: inline-block; padding: 0 .45em; border: 1px solid var(--line); border-radius: 999px; font-size: .75rem; line-height: 1.5; margin-right: .35em; }
.chip.fail { color: var(--fail); border-color: currentColor; }
.chip.warn { color: var(--warn); border-color: currentColor; }
.chip.pass { color: var(--pass); border-color: currentColor; }
.chip.state { color: var(--accent); }
.layout { display: grid; gap: 16px; }
@media (min-width: 900px) {
  .layout { grid-template-columns: minmax(260px, 340px) 1fr; align-items: start; }
  .layout > nav { position: sticky; top: 0; max-height: 100vh; overflow: auto; }
}
.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.finding { width: 100%; text-align: left; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; display: grid; gap: 2px; }
.finding[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.finding:focus-visible, .export:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; overflow-wrap: anywhere; }
.detail { min-width: 0; }
.detail > h2 { margin-top: 0; }
.nodes { padding-left: 1.2rem; }
.nodes li { margin-bottom: .35rem; }
.export { font: inherit; color: var(--accent); background: none; border: 1px solid var(--accent); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.sequence { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.line { flex: 1 1 100%; margin: 0; font-size: .85rem; overflow-wrap: anywhere; }
.finding-line strong { color: var(--fail); }
.frame { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px; flex: 0 1 auto; }
.frame.tall { width: min(100%, 300px); }
.frame.wide { width: min(100%, 560px); }
.frame figcaption { font-size: .8rem; margin-top: 6px; overflow-wrap: anywhere; }
.shot { position: relative; width: 100%; background: var(--line); overflow: hidden; border-radius: 4px; }
.shot img { display: block; width: 100%; height: 100%; }
.missing { padding: 1rem; margin: 0; }
.box { position: absolute; border: 2px solid var(--box); border-radius: 2px; box-shadow: 0 0 0 9999px rgb(0 0 0 / .08); pointer-events: none; }
.box.hit { border-color: var(--hit); }
.notes { list-style: none; padding: 0; margin: 4px 0 0; }
.swatch { display: inline-block; width: .7em; height: .7em; border: 2px solid var(--box); margin-right: .4em; vertical-align: -1px; }
.swatch.hit { border-color: var(--hit); }
details { border-top: 1px solid var(--line); padding: 8px 0; }
summary { cursor: pointer; }
details > .sequence { margin-top: 8px; }
`;

const SCRIPT = [
  `const esc = ${esc};`,
  `const jsonIn = ${jsonIn};`,
  `const pageHtml = ${pageHtml};`,
  `const describeEvent = ${describeEvent};`,
  `const momentsOf = ${momentsOf};`,
  `const extractOf = ${extractOf};`,
  `(${main})(JSON.parse(document.getElementById('kanso-data').textContent));`,
].join('\n');
