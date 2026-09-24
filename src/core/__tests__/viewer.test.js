import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { clearRecord, readJournals, writeRecord } from '../record.js';
import { extractOf, momentsOf, renderViewer, viewerData } from '../viewer.js';

// A record as a focus probe and axe leave one: a finding of the probe on the
// drawer, one of axe on the page as it loads, and one of Lighthouse's own. The
// result's elements have no path, as findings.js folds them; the journal's
// have theirs.
const TRIGGER = { path: '1,HTML,1,BODY,1,MAIN,4,BUTTON', selector: 'body > main#page > button#drawer-open' };
const DRAWER = { path: '1,HTML,1,BODY,3,DIV', selector: 'body > div#drawer' };
const LOGO = { path: '1,HTML,1,BODY,0,IMG', selector: 'body > img' };

const RESULT = {
  url: 'http://127.0.0.1:4000/',
  baseline: null,
  ok: true,
  conclusion: 'fail',
  modules: {
    accessibility: {
      findings: [
        { rule: 'focus-not-moved', at: 'drawer', title: 'Keyboard focus stays behind an open modal dialog', impact: 'serious', count: 1, formFactors: ['mobile'], nodes: [{ selector: DRAWER.selector, explanation: 'focus stayed on </script><script>alert(1)</script>' }], state: null, level: 'fail' },
        { rule: 'image-alt', title: 'Images must have alternate text', impact: 'critical', count: 1, formFactors: ['mobile'], nodes: [{ selector: LOGO.selector }], state: null, level: 'fail' },
      ],
      probeFailures: [{ probe: 'keyboard', rules: ['focus-trap'], error: 'timed out after 30s', at: 'drawer' }],
    },
    seo: { findings: [{ rule: 'meta-description', title: 'No meta description', impact: 'minor', count: 1, formFactors: ['mobile'], nodes: [], state: null, level: 'warn' }] },
    performance: { levels: {} },
  },
};

const MOBILE = [
  { seq: 0, t: 0, kind: 'load', url: RESULT.url, side: 'current', formFactor: 'mobile', run: 1 },
  { seq: 1, t: 5, kind: 'probe-start', probe: 'axe', module: 'accessibility', states: ['drawer'] },
  { seq: 2, t: 9, kind: 'loaded', probe: 'axe', url: RESULT.url, frame: { file: 'frames/current.mobile.1/2.jpg', width: 412, height: 823, scale: 1.75 } },
  { seq: 3, t: 20, kind: 'state-reached', probe: 'axe', at: 'drawer', click: '#drawer-open', frame: { file: 'frames/current.mobile.1/3.jpg', width: 412, height: 823, scale: 1.75 } },
  { seq: 4, t: 21, kind: 'finding', probe: 'axe', rule: 'image-alt', count: 1, nodes: [LOGO] },
  { seq: 5, t: 22, kind: 'probe-end', probe: 'axe', findings: 1 },
  { seq: 6, t: 30, kind: 'probe-start', probe: 'focus', module: 'accessibility', states: ['drawer'] },
  { seq: 7, t: 31, kind: 'loaded', probe: 'focus', at: 'drawer', url: RESULT.url, frame: { file: 'frames/current.mobile.1/7.jpg', width: 412, height: 823, scale: 1.75 } },
  { seq: 8, t: 40, kind: 'open', probe: 'focus', at: 'drawer', by: 'keyboard', opened: true, key: 'Enter', focusable: true, frame: { file: 'frames/current.mobile.1/8.jpg', width: 412, height: 823, scale: 1.75 } },
  { seq: 9, t: 41, kind: 'focus', probe: 'focus', at: 'drawer', why: 'opened', ...TRIGGER, rect: { x: 16, y: 200, width: 90, height: 40 } },
  { seq: 10, t: 50, kind: 'close', probe: 'focus', at: 'drawer', by: 'escape', closed: false, frame: { file: 'frames/current.mobile.1/10.jpg', width: 412, height: 823, scale: 1.75 } },
  { seq: 11, t: 51, kind: 'finding', probe: 'focus', at: 'drawer', rule: 'focus-not-moved', count: 1, nodes: [DRAWER] },
  { seq: 12, t: 52, kind: 'probe-end', probe: 'focus', findings: 1 },
];

const LOADS = [
  { name: 'current.mobile.1.jsonl', side: 'current', formFactor: 'mobile', run: 1, events: MOBILE },
  // The desktop load found nothing: none of these findings is from there.
  { name: 'current.desktop.1.jsonl', side: 'current', formFactor: 'desktop', run: 1, events: MOBILE.map((e) => ({ ...e, formFactor: 'desktop' })) },
];

const FRAMES = Object.fromEntries(MOBILE.filter((e) => e.frame).map((e) => [e.frame.file, `data:image/jpeg;base64,${e.seq}`]));

function data() {
  return viewerData({ result: RESULT, loads: LOADS, frames: FRAMES });
}

// The data inside a page, read back as the page reads it.
function dataIn(html) {
  const [, json] = /<script type="application\/json" id="kanso-data">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(json);
}

test('the findings of every module make one list, each with a key and its module', () => {
  const { findings, failures, conclusion } = data();
  assert.deepEqual(findings.map(({ key, module, rule, at }) => [key, module, rule, at ?? null]), [
    ['f0', 'accessibility', 'focus-not-moved', 'drawer'],
    ['f1', 'accessibility', 'image-alt', null],
    ['f2', 'seo', 'meta-description', null],
  ]);
  assert.deepEqual(failures.map(({ module, probe, at }) => [module, probe, at]), [['accessibility', 'keyboard', 'drawer']]);
  assert.equal(conclusion, 'fail');
});

// The join: rule, state and element find the finding event; its probe's way
// through that state is what produced it.
test('a finding in a state is joined to its probe’s moments in that state, on the form factors it was found on', () => {
  const [focus] = data().findings;
  assert.deepEqual(momentsOf(focus, LOADS[0]).map((e) => e.seq), [7, 8, 9, 10, 11]);
  assert.deepEqual(momentsOf(focus, LOADS[1]), []);
});

test('a finding as the page loads is joined to the page loaded, not to the states after', () => {
  const [, logo] = data().findings;
  assert.deepEqual(momentsOf(logo, LOADS[0]).map((e) => [e.seq, e.kind]), [[2, 'loaded'], [4, 'finding']]);
});

test('a finding no probe made has no moment', () => {
  const [, , description] = data().findings;
  assert.deepEqual(momentsOf(description, LOADS[0]), []);
});

test('an extract carries its finding, its moments and their frames, and nothing else', () => {
  const extract = extractOf(data(), 'f0');
  assert.equal(extract.kind, 'extract');
  assert.deepEqual(extract.findings.map((f) => f.rule), ['focus-not-moved']);
  assert.deepEqual(extract.failures, []);
  assert.deepEqual(extract.loads.map((l) => [l.name, l.events.map((e) => e.seq)]), [['current.mobile.1.jsonl', [7, 8, 9, 10, 11]]]);
  assert.deepEqual(Object.keys(extract.frames).sort(), ['frames/current.mobile.1/10.jpg', 'frames/current.mobile.1/7.jpg', 'frames/current.mobile.1/8.jpg']);
});

test('the page holds its data whole, and nothing in it ends its script early', () => {
  const html = renderViewer(data());

  assert.deepEqual(dataIn(html), data());
  // Two scripts, two closing tags: the one in a finding's text is escaped.
  assert.equal(html.match(/<\/script/gi).length, 2);
  assert.equal(html.match(/<script/gi).length, 2);
  assert.doesNotMatch(html, /<script><\/script>alert/);
  assert.match(html, /data:image\/jpeg;base64,8/);
  // Nothing fetched from anywhere: the page opens from the disk.
  assert.doesNotMatch(html, /\bsrc="http|\bhref="http|@import|url\(http/);

  // The page's own script is JavaScript as it stands.
  const [, app] = /<script id="kanso-app">([\s\S]*?)<\/script>/.exec(html);
  assert.doesNotThrow(() => new Script(app));
});

// The page makes an extract with the same function it is rendered with: an
// extract is a page like the record, with less in it.
test('an extract is a page of its own, holding only its finding', () => {
  const html = renderViewer(extractOf(data(), 'f0'));
  const extract = dataIn(html);
  assert.deepEqual(extract.findings.map((f) => f.key), ['f0']);
  assert.match(html, /<title>Kanso · focus-not-moved @ drawer<\/title>/);
  assert.doesNotMatch(html, /base64,2"/);
});

test('a record is written with its page, which inlines the journals and the frames on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanso-record-'));
  mkdirSync(join(dir, 'frames', 'current.mobile.1'), { recursive: true });
  writeFileSync(join(dir, 'frames', 'current.mobile.1', '8.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(join(dir, 'current.mobile.1.jsonl'), MOBILE.map((e) => JSON.stringify(e)).join('\n') + '\n{"cut sh');
  writeFileSync(join(dir, 'baseline.mobile.1.jsonl'), '');

  const page = writeRecord(dir, RESULT);

  assert.equal(page, join(dir, 'index.html'));
  const shown = dataIn(readFileSync(page, 'utf8'));
  assert.deepEqual(shown.loads.map((l) => [l.name, l.events.length]), [['current.mobile.1.jsonl', MOBILE.length], ['baseline.mobile.1.jsonl', 0]]);
  // The frame on disk is inlined; the ones that are not there are left out.
  assert.deepEqual(shown.frames, { 'frames/current.mobile.1/8.jpg': 'data:image/jpeg;base64,/9j/' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8')).url, RESULT.url);
  assert.equal(readJournals(dir).loads.length, 2);
});

test('a record directory loses what an earlier audit wrote there, frames and page included, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanso-record-'));
  mkdirSync(join(dir, 'frames', 'current.mobile.1'), { recursive: true });
  writeFileSync(join(dir, 'frames', 'current.mobile.1', '1.jpg'), 'x');
  writeFileSync(join(dir, 'index.html'), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'mine');

  clearRecord(dir);

  assert.throws(() => readFileSync(join(dir, 'index.html')));
  assert.throws(() => readFileSync(join(dir, 'frames', 'current.mobile.1', '1.jpg')));
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
});
