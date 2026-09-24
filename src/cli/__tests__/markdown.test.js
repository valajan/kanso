import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from '../markdown.js';

const mobileScore  = { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 };
const desktopScore = { performance: 98, lcp: 1500, tbt: 50,  cls: 0.02, fcp: 900 };

const noReference = {
  mobile:  { current: mobileScore,  reference: null },
  desktop: { current: desktopScore, reference: null },
};

// The report is written by `kanso audit --out report.md`, and it is what a CI
// job summary shows.
const report = (scores, options = {}) => formatReport(scores, { header: '🔗 `dist`', ...options });

test('names what was audited under the title', () => {
  const body = report(noReference);
  assert.match(body, /^## Kanso \| Audit Report\n\n🔗 `dist`\n/);
});

test('renders Mobile and Desktop sections side by side', () => {
  const body = report(noReference);
  assert.ok(body.includes('### 📱 Mobile'));
  assert.ok(body.includes('### 💻 Desktop'));
  // mobile perf cell: Lighthouse's "poor" boundary as the budget, no reference
  assert.ok(body.includes('| Performance | 49 | — | 95 |'));
  // desktop perf cell
  assert.ok(body.includes('| Performance | 49 | — | 98 |'));
});

test('renders deltas and a pass icon when the page improves on its baseline', () => {
  const scores = {
    mobile:  { current: mobileScore,  reference: { performance: 90, lcp: 2500, tbt: 150, cls: 0.08, fcp: 1500 } },
    desktop: { current: desktopScore, reference: null },
  };
  const body = report(scores);
  assert.ok(body.includes('| Metric | budget | baseline | current | Δ | |'));
  assert.ok(body.includes('| Performance | 49 | 90 | 95 | +5 | ✅ |'));
  assert.ok(body.includes('| LCP | 4000ms | 2500ms | 2000ms | -500ms | ✅ |'));
});

test('marks a metric outside its budget as failed', () => {
  const scores = {
    mobile:  { current: { ...mobileScore, lcp: 5000 }, reference: { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 } },
    desktop: { current: desktopScore, reference: null },
  };
  const body = report(scores, { budget: { lcp: 4000 } });
  assert.ok(body.includes('| LCP | 4000ms | 2000ms | 5000ms | +3000ms | ❌ |'));
});

// The icon is read against the budget, the Δ against the baseline: a page
// scoring what its baseline scores still fails a budget both miss, and the row
// says which.
test('a metric equal to its baseline that fails its budget shows the budget it fails', () => {
  const scores = {
    mobile:  { current: mobileScore,  reference: mobileScore },
    desktop: { current: desktopScore, reference: desktopScore },
  };
  const body = report(scores, { budget: { performance: 101 } });
  assert.ok(body.includes('| Performance | 101 | 95 | 95 | +0 | ❌ |'));
});

test('against budgets alone, the budget is the reference column and Δ the distance to it', () => {
  const body = report(noReference, { budget: { lcp: 3000 }, referenceLabel: 'budget', referenceKind: 'budgets' });
  assert.ok(body.includes('| Metric | budget | current | Δ | |'));
  assert.ok(body.includes('| LCP | 3000ms | 2000ms | -1000ms | ✅ |'));
});

test('reports a failed audit for a missing form factor', () => {
  const body = report({ mobile: { current: mobileScore, reference: null }, desktop: { current: null, reference: null } });
  assert.ok(body.includes('### 💻 Desktop'));
  assert.ok(body.includes('Lighthouse audit failed'));
});

// --- findings sections ------------------------------------------------------

const accessibility = (findings, extra = {}) => ({
  accessibility: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings, ...extra },
});

test('renders a findings section with the failing elements folded away', () => {
  const body = report(noReference, {
    modules: accessibility([
      { rule: 'image-alt', title: 'Images lack an alt attribute.', impact: 'critical', count: 2, state: 'new', level: 'fail', nodes: [{ selector: 'img.logo' }, { selector: 'img.hero' }] },
      { rule: 'heading-order', title: 'Headings skip a level.', impact: 'moderate', count: 1, state: 'new', level: 'warn', nodes: [{ selector: 'h3.sub' }] },
    ]),
  });

  assert.ok(body.includes('### ♿ Accessibility'));
  assert.ok(body.includes('| `image-alt` | critical | 2 elements | new | ❌ |'));
  assert.ok(body.includes('| `heading-order` | moderate | 1 element | new | ⚠️ |'));
  assert.ok(body.includes('<details><summary>What failed, and where</summary>'));
  assert.ok(body.includes('- `img.logo`'));
  assert.ok(body.includes('_failing from `serious` up_'));
});

test('the failing elements say what is wrong with them, once when it is the same', () => {
  const body = report(noReference, {
    modules: accessibility([
      { rule: 'image-alt', title: 't', impact: 'critical', count: 2, state: null, level: 'fail', nodes: [
        { selector: 'img.logo', snippet: '<img src="/logo.png">', explanation: 'Fix any of the following:\n  Element does not have an alt attribute' },
        { selector: 'img.hero', explanation: 'Fix any of the following:\n  Element does not have an alt attribute' },
      ] },
      { rule: 'color-contrast', title: 't', impact: 'serious', count: 2, state: null, level: 'fail', nodes: [
        { selector: 'p.muted', label: 'Get\n  started', explanation: 'Fix any of the following:\n  Element has insufficient color contrast of 4.27' },
        { selector: 'a.cta', explanation: 'Fix any of the following:\n  Element has an <svg> with role=*img*' },
      ] },
    ]),
  });

  assert.ok(body.includes('**`image-alt`** — t\nElement does not have an alt attribute\n- `img.logo` `<img src="/logo.png">`\n- `img.hero`'));
  assert.ok(body.includes('- `p.muted` “Get started” — Element has insufficient color contrast of 4.27'));
  assert.ok(body.includes('- `a.cta` — Element has an \\<svg\\> with role=\\*img\\*'), 'axe\'s text is not read as markup');
});

test('the verdict counts the findings alongside the metrics', () => {
  const body = report(noReference, {
    modules: accessibility([
      { rule: 'image-alt', title: 't', impact: 'critical', count: 1, state: 'new', level: 'fail', nodes: [] },
      { rule: 'label', title: 't', impact: 'serious', count: 1, state: 'inherited', level: 'pass', nodes: [] },
    ]),
  });

  assert.ok(body.includes('> ❌ 1 Accessibility finding\n'), body.split('\n').slice(0, 6).join('\n'));
});

// A reader cannot tell a clean page from a page whose findings were all there
// before, unless the report says which it is.
test('a compared section says what was inherited and what was fixed', () => {
  const body = report(noReference, {
    modules: accessibility(
      [{ rule: 'label', title: 't', impact: 'serious', count: 2, state: 'inherited', level: 'pass', nodes: [] }],
      { comparedToBaseline: true, fixed: [{ rule: 'link-name', title: 't', impact: 'serious', count: 1 }] },
    ),
  });

  assert.ok(body.includes('| `label` | serious | 2 elements | inherited | ✅ |'));
  assert.ok(body.includes('_failing from `serious` up · 1 already on `baseline` · 1 fixed_'));
  assert.ok(!body.includes('<details>'), 'nothing to fix, nothing to unfold');
});

// A change that fixed every finding leaves an empty section, which still has
// to say what was fixed — and has nothing to say of what was already there.
test('an emptied section says what was fixed', () => {
  const body = report(noReference, {
    modules: accessibility([], { comparedToBaseline: true, fixed: [{ rule: 'link-name', title: 't', impact: 'serious', count: 1 }] }),
  });

  assert.ok(body.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up · 1 fixed_'));
  assert.ok(!body.includes('already on'));
});

test('the verdict names metrics as the tables do', () => {
  const failing = {
    mobile:  { current: { ...mobileScore, performance: 40, lcp: 5000, tbt: 300 }, reference: null },
    desktop: { current: desktopScore, reference: null },
  };
  assert.ok(report(failing).includes('> ❌ Performance, LCP failed · ⚠️ TBT warning'));
});

test('a module that found nothing says so, and the ones that ran nothing say nothing', () => {
  const clean = report(noReference, { modules: accessibility([]) });
  assert.ok(clean.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up_'));

  const absent = report(noReference, { modules: accessibility(null) });
  assert.ok(!absent.includes('### ♿ Accessibility'));
});

// SEO and best practices report through the same section as accessibility,
// and their failures are not all DOM elements: a console error is a script and
// a line, a missing doctype is nothing at all.
test('a failure with no DOM element is shown by what it names, or by what Lighthouse says of it', () => {
  const body = report(noReference, {
    modules: {
      'best-practices': { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [
        { rule: 'doctype', title: 'Page lacks the HTML doctype', impact: 'moderate', count: 0, state: null, level: 'warn', nodes: [], detail: 'Document must contain a doctype' },
        { rule: 'errors-in-console', title: 'Browser errors were logged to the console', impact: 'moderate', count: 1, state: null, level: 'warn', nodes: [
          { selector: '', snippet: '', label: '', explanation: 'Description: Failed to load resource: 404', url: 'http://localhost:4173/favicon.ico:1:0' },
        ] },
      ] },
    },
  });

  assert.ok(body.includes('### 🧰 Best Practices'));
  assert.ok(body.includes('| `doctype` | moderate |  | — | ⚠️ |'), 'a rule broken as a whole has no element count');
  assert.ok(body.includes('| `errors-in-console` | moderate | 1 item | — | ⚠️ |'));
  assert.ok(body.includes('**`doctype`** — Page lacks the HTML doctype\nDocument must contain a doctype'));
  assert.ok(body.includes('Description: Failed to load resource: 404\n- `http://localhost:4173/favicon.ico:1:0`'));
});

test('a missing tag is listed by what is missing, with no empty place before it', () => {
  const body = report(noReference, {
    modules: {
      seo: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [
        { rule: 'open-graph', title: 'Open Graph tags are missing or unusable', impact: 'minor', count: 2, state: null, level: 'warn', nodes: [
          { selector: '', snippet: '', label: '', explanation: 'og:description is missing' },
          { selector: 'head > meta', snippet: '<meta property="og:image" content="/og.png">', label: '', explanation: 'og:image is not an absolute URL: /og.png' },
        ] },
      ] },
    },
  });

  assert.ok(body.includes('| `open-graph` | minor | 2 items | — | ⚠️ |'));
  assert.ok(body.includes('**`open-graph`** — Open Graph tags are missing or unusable\n- og:description is missing\n- `head > meta` `<meta property="og:image" content="/og.png">` — og:image is not an absolute URL: /og.png'));
});

test('a probe that did not run is said under its section, with the rules it left unchecked', () => {
  const body = report(noReference, {
    modules: accessibility([], { probeFailures: [{ probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'], side: 'baseline', formFactor: 'mobile', error: 'timed out after 30s' }] }),
  });

  assert.ok(body.includes('_failing from `serious` up_\n_⚠️ `reflow` did not run on the mobile reference (timed out after 30s): `reflow-scroll`, `reflow-clip` unchecked_'));
});

test('each module reporting findings gets its own section, and says what it ignored', () => {
  const body = report(noReference, {
    modules: { seo: { levels: {}, fixed: [], comparedToBaseline: false, failOn: 'serious', findings: [], ignore: ['is-crawlable'] } },
  });

  assert.ok(body.includes('### 🔍 SEO'));
  assert.ok(body.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up · ignoring `is-crawlable`_'), 'what was not looked at is said');
});

// A rule broken in a state the project declares says which, in the table and
// over its elements; one broken as the page loads says nothing more than before.
test('a finding made in a declared state says where', () => {
  const body = report(noReference, {
    modules: accessibility([
      { rule: 'button-name', at: 'menu', title: 'Buttons do not have an accessible name', impact: 'critical', count: 1, state: 'new', level: 'fail', nodes: [{ selector: 'nav > button' }] },
      { rule: 'button-name', title: 'Buttons do not have an accessible name', impact: 'critical', count: 1, state: 'new', level: 'fail', nodes: [{ selector: 'header > button' }] },
    ]),
  });

  assert.ok(body.includes('| `button-name` @ `menu` | critical | 1 element | new | ❌ |'));
  assert.ok(body.includes('| `button-name` | critical | 1 element | new | ❌ |'));
  assert.ok(body.includes('**`button-name`** @ `menu` — Buttons do not have an accessible name'));
});

test('a state that could not be reached is said, with how many rules went unchecked there', () => {
  const rules = Array.from({ length: 100 }, (_, i) => `rule-${i}`);
  const body = report(noReference, {
    modules: accessibility([], { probeFailures: [{ probe: 'axe', rules, at: 'menu', side: 'current', formFactor: 'desktop', error: 'nothing visible to click at #open' }] }),
  });

  assert.ok(body.includes('_⚠️ `menu` could not be reached on the desktop page (nothing visible to click at #open): 100 rules unchecked there_'));
});

// INP is only measured on declared clicks: without any, its row has no value
// and no icon, and a line under the tables says why — once.
test('an INP nobody measured has no icon, and the report says why', () => {
  const body = report(noReference, { modules: { performance: { skipped: [{ probe: 'inp', rules: ['inp'], reason: 'no-states' }] } } });
  assert.ok(body.includes('| INP | 500ms | — | — | — |  |'));
  assert.equal(body.match(/_⏭️ `inp` skipped: no `states:` declared in `\.kanso\.yml`, so nothing was opened or clicked: `INP` not checked\. `kanso discover --write` finds them\._/g).length, 1);
});

// Skipped is neither failed nor clean: said under the section, after what it
// was judged against, apart from a probe that did not run.
test('a probe skipped for want of a state is said under its section, with its rules', () => {
  const skipped = [
    { probe: 'residues', rules: ['page-locked', 'overlay-left'], reason: 'no-states' },
    { probe: 'leaks', rules: ['dom-leak', 'listener-leak'], reason: 'no-states' },
  ];
  const body = report(noReference, {
    modules: { interactions: { findings: [], fixed: [], comparedToBaseline: false, failOn: 'serious', ignore: [], probeFailures: [], skipped } },
  });

  assert.ok(body.includes('_No findings — every rule checked passed._\n\n_failing from `serious` up_\n'
    + '_⏭️ `residues`, `leaks` skipped: no `states:` declared in `.kanso.yml`, so nothing was opened or clicked: '
    + '`page-locked`, `overlay-left`, `dom-leak`, `listener-leak` not checked. `kanso discover --write` finds them._\n'));
  assert.doesNotMatch(body, /⚠️/);
});

test('a state the INP could not reach is said under its table, apart from it', () => {
  const diagnostics = {
    mobile: { current: { inp: { interaction: null, count: 1, failures: [{ at: 'signup', error: 'nothing visible to click at #signup' }] } } },
    desktop: { current: { inp: { interaction: null, count: 1, failures: [] } } },
  };
  const scores = {
    mobile: { current: { ...mobileScore, inp: 120 }, reference: null },
    desktop: { current: { ...desktopScore, inp: 80 }, reference: null },
  };
  const body = report(scores, { diagnostics, referenceKind: 'budgets', referenceLabel: 'budget' });

  assert.ok(body.includes('| INP | 500ms | 120ms | -380ms | ✅ |'));
  // A blank line between: GFM would read a line right under a table as a row.
  assert.match(body, /\| INP \| 500ms \| 120ms \| -380ms \| ✅ \|\n\n_⚠️ `signup` could not be reached \(nothing visible to click at #signup\): its click is not in the INP_\n/);
  assert.doesNotMatch(body, /INP not measured/);
});
