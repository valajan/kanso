import { test } from 'node:test';
import assert from 'node:assert/strict';
import performance from '../index.js';
import { extractDiagnostics, pickDiagnostics } from '../diagnostics.js';

// The three insights as Lighthouse 13 reports them, trimmed to what is read.
function node(selector, label = selector) {
  return { type: 'node', selector, snippet: `<${selector}>`, nodeLabel: label, path: '1,HTML' };
}

const LCP_BREAKDOWN = {
  details: { type: 'list', items: [
    { type: 'table', items: [
      { subpart: 'timeToFirstByte', label: 'Time to first byte', duration: 4.679 },
      { subpart: 'elementRenderDelay', label: 'Element render delay', duration: 110.385 },
    ] },
    node('p.hero', 'Kanso runs Lighthouse…'),
  ] },
};

const RENDER_BLOCKING = {
  details: { type: 'table', items: [
    { url: 'http://localhost/entry.css', totalBytes: 6055, wastedMs: 153.4 },
    { url: 'http://localhost/index.css', totalBytes: 2110, wastedMs: 303.2 },
  ] },
};

function cluster(total, ...shifts) {
  return { type: 'table', items: [{ node: { type: 'text', value: 'Total' }, score: total }, ...shifts] };
}

const CLS_CULPRITS = {
  details: { type: 'list', items: [
    cluster(0.05, { node: node('footer'), score: 0.05 }),
    cluster(0.36452, {
      node: node('main'),
      score: 0.36452,
      subItems: { type: 'subitems', items: [
        { extra: node('img.hero'), cause: 'Unsized image element' },
        { extra: { type: 'url', value: 'http://localhost/font.woff2' }, cause: 'Web font' },
      ] },
    }),
  ] },
};

function lhr(audits) {
  return { audits };
}

test('the LCP breakdown names the element and splits its observed time', () => {
  const { lcp } = extractDiagnostics(lhr({ 'lcp-breakdown-insight': LCP_BREAKDOWN }));

  assert.deepEqual(lcp, {
    element: { selector: 'p.hero', snippet: '<p.hero>', label: 'Kanso runs Lighthouse…' },
    observedMs: 115,
    subparts: { timeToFirstByte: 5, elementRenderDelay: 110 },
  });
});

test('the render-blocking requests come longest first', () => {
  const { renderBlocking } = extractDiagnostics(lhr({ 'render-blocking-insight': RENDER_BLOCKING }));

  assert.deepEqual(renderBlocking, [
    { url: 'http://localhost/index.css', totalBytes: 2110, wastedMs: 303 },
    { url: 'http://localhost/entry.css', totalBytes: 6055, wastedMs: 153 },
  ]);
});

// The CLS is the worst cluster's score, so its shifts are the ones that explain
// the number; a smaller cluster elsewhere on the timeline does not.
test('the layout shifts are the worst cluster\'s, with what caused them', () => {
  const { cls } = extractDiagnostics(lhr({ 'cls-culprits-insight': CLS_CULPRITS }));

  assert.equal(cls.score, 0.365);
  assert.equal(cls.shifts.length, 1);
  assert.equal(cls.shifts[0].element.selector, 'main');
  assert.deepEqual(cls.shifts[0].causes, [
    { cause: 'Unsized image element', element: { selector: 'img.hero', snippet: '<img.hero>', label: 'img.hero' } },
    { cause: 'Web font', url: 'http://localhost/font.woff2' },
  ]);
});

test('a page Lighthouse had nothing to say about has no diagnostics', () => {
  assert.deepEqual(extractDiagnostics(lhr({})), { lcp: null, renderBlocking: [], cls: null });
  assert.equal(extractDiagnostics(lhr({ 'cls-culprits-insight': { details: { type: 'list', items: [] } } })).cls, null);
});

// Medians are taken one metric at a time, so the LCP's explanation comes from
// the load with the median LCP, and the CLS's from the load with the median CLS.
test('each diagnostic comes from the load that produced its median', () => {
  const load = (name, lcp, cls, inp = null) => ({ lcp, cls, inp, diagnostics: { lcp: name, renderBlocking: [name], cls: name, inp: name } });
  const samples = [load('a', 1000, 0.3, 120), load('b', 3000, 0.1, 400), load('c', 2000, 0.0, 250)];

  assert.deepEqual(pickDiagnostics(samples, { lcp: 2000, cls: 0.1, inp: 250 }), { lcp: 'c', renderBlocking: ['c'], cls: 'b', inp: 'c' });
  // An even count: the median sits halfway between two loads, and the first
  // of them to have run is taken.
  const four = [load('a', 1000, 0), load('b', 4000, 0), load('c', 3000, 0), load('d', 2000, 0)];
  assert.equal(pickDiagnostics(four, { lcp: 2500, cls: 0 }).lcp, 'c');
});

// No INP to be nearest to — nothing clicked, or nothing reached — still says
// why: the first load's account of it.
test('with no INP measured, the first load says why', () => {
  const load = (name) => ({ lcp: 1000, cls: 0, inp: null, diagnostics: { inp: name } });
  assert.equal(pickDiagnostics([load('a'), load('b')], { lcp: 1000, cls: 0 }).inp, 'a');
});

test('combine reports the median measures and the diagnostics behind them', () => {
  const load = (lcp, name) => ({ performance: 90, lcp, tbt: 0, cls: 0, fcp: 800, diagnostics: { lcp: name, renderBlocking: [], cls: null } });

  const combined = performance.combine([load(1200, 'fast'), load(1500, 'median'), null, load(4000, 'slow')]);

  assert.equal(combined.lcp, 1500);
  assert.equal(combined.diagnostics.lcp, 'median');
});

// Diagnostics explain; they are never compared or judged. The score table sees
// the measures alone, whatever a load carried besides.
test('evaluate reports the diagnostics beside the scores, and judges only the measures', () => {
  const measures = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
  const diagnostics = { lcp: { element: null, observedMs: 100, subparts: {} }, renderBlocking: [], cls: null };
  const sides = { current: { ...measures, diagnostics }, baseline: { ...measures, diagnostics } };

  const result = performance.evaluate({ formFactors: { mobile: sides, desktop: sides }, baselineAudited: true }, {});

  assert.deepEqual(result.scores.mobile, { current: measures, reference: measures });
  assert.deepEqual(result.diagnostics.mobile, { current: diagnostics, baseline: diagnostics });
  assert.equal(result.levels.lcp, 'pass');

  const againstBudgets = performance.evaluate({ formFactors: { mobile: sides, desktop: sides }, baselineAudited: false }, {});
  assert.equal(againstBudgets.diagnostics.mobile.baseline, null, 'a baseline that was not audited explains nothing');
});
