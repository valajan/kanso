import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findingEvent, Journal, journalPath, NO_JOURNAL } from '../journal.js';

function clock(...times) {
  return () => times.shift();
}

test('each event carries its order, its time since the load began, and the context of its view', () => {
  const journal = new Journal({ now: clock(1000, 1005, 1012, 1030) });
  const probe = journal.with({ probe: 'keyboard' });

  journal.log('load', { url: 'http://localhost/' });
  probe.log('probe-start');
  probe.with({ at: 'menu' }).log('tab-stop', { index: 0 });

  assert.deepEqual(journal.events, [
    { seq: 0, t: 5, kind: 'load', url: 'http://localhost/' },
    { seq: 1, t: 12, kind: 'probe-start', probe: 'keyboard' },
    { seq: 2, t: 30, kind: 'tab-stop', probe: 'keyboard', at: 'menu', index: 0 },
  ]);
});

test('a journal is written one event a line, where the load says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanso-journal-'));
  const journal = new Journal({ now: clock(0, 1, 2) });
  journal.log('load');
  journal.with({ probe: 'reflow' }).log('probe-end', { findings: 0 });

  const path = journalPath(join(dir, 'rec'), { side: 'current', formFactor: 'mobile', run: 1 });
  journal.write(path);

  assert.equal(path, join(dir, 'rec', 'current.mobile.1.jsonl'));
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((e) => e.kind), ['load', 'probe-end']);
});

test('NO_JOURNAL takes every call, through any view, and keeps nothing', () => {
  NO_JOURNAL.log('load', { url: 'x' });
  NO_JOURNAL.with({ probe: 'axe' }).with({ at: 'menu' }).log('finding');
  assert.equal(NO_JOURNAL.events, undefined);
});

test('a finding is kept as what finds it again in the report: rule, state, elements by path', () => {
  const event = findingEvent({
    rule: 'focus-visible', at: 'menu', impact: 'serious', count: 2, title: 'Keyboard focus is not visible',
    nodes: [{ path: '1,HTML,1,BODY,0,A', selector: 'body > a', snippet: '<a href="/">', label: 'Home', explanation: 'focused with no visible change' }],
  });
  assert.deepEqual(event, {
    rule: 'focus-visible', at: 'menu', impact: 'serious', count: 2,
    nodes: [{ path: '1,HTML,1,BODY,0,A', selector: 'body > a', explanation: 'focused with no visible change' }],
  });
});

// A page as a frame sees it: a screenshot, and the size of what it shows.
function fakePage({ fails = false } = {}) {
  const page = {
    shots: 0,
    async screenshot(options) {
      page.shots++;
      page.options = options;
      if (fails) throw new Error('Target closed');
      return new Uint8Array([0xff, 0xd8, page.shots]);
    },
    async evaluate() {
      return { width: 412, height: 823, scale: 1.75 };
    },
  };
  return page;
}

test('a shot logs the event with a frame of the viewport: its file, its size in CSS pixels, its scale', async () => {
  const journal = new Journal({ now: clock(0, 3, 9) });
  const page = fakePage();
  await journal.with({ probe: 'focus', at: 'menu' }).shot(page, 'open', { by: 'keyboard' });
  journal.log('close');

  assert.deepEqual(page.options, { type: 'jpeg', quality: 60 });
  assert.deepEqual(journal.events, [
    { seq: 0, t: 3, kind: 'open', probe: 'focus', at: 'menu', by: 'keyboard', frame: { file: '0.jpg', width: 412, height: 823, scale: 1.75 } },
    { seq: 1, t: 9, kind: 'close' },
  ]);
  assert.deepEqual([...journal.frames.keys()], ['0.jpg']);
});

test('a frame that cannot be taken leaves the event without one, and the probe carries on', async () => {
  const journal = new Journal({ now: clock(0, 1) });
  await journal.shot(fakePage({ fails: true }), 'loaded', { url: 'x' });
  assert.deepEqual(journal.events, [{ seq: 0, t: 1, kind: 'loaded', url: 'x' }]);
  assert.equal(journal.frames.size, 0);
});

test('a load takes forty frames at most; the moments after are logged without one', async () => {
  const journal = new Journal();
  const page = fakePage();
  for (let i = 0; i < 45; i++) await journal.shot(page, 'open');
  assert.equal(page.shots, 40);
  assert.equal(journal.events.filter((e) => e.frame).length, 40);
  assert.equal(journal.events.length, 45);
});

// A probe that measures is handed a view without frames: a screenshot in the
// middle of its clicks would be timed with them.
test('a view without frames, and NO_JOURNAL, take no screenshot', async () => {
  const journal = new Journal({ now: clock(0, 1) });
  const page = fakePage();
  await journal.with({ probe: 'inp' }).withoutFrames().with({ at: 'menu' }).shot(page, 'state-reached', { click: '#m' });
  await NO_JOURNAL.shot(page, 'loaded');
  await NO_JOURNAL.with({ probe: 'x' }).withoutFrames().shot(page, 'loaded');

  assert.equal(page.shots, 0);
  assert.deepEqual(journal.events, [{ seq: 0, t: 1, kind: 'state-reached', probe: 'inp', at: 'menu', click: '#m' }]);
});

test('frames are written beside the journal, under frames/<journal>/, the events naming them by that path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanso-journal-'));
  const journal = new Journal();
  await journal.shot(fakePage(), 'loaded');

  journal.write(journalPath(dir, { side: 'current', formFactor: 'mobile', run: 1 }));

  const [event] = readFileSync(join(dir, 'current.mobile.1.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(event.frame.file, 'frames/current.mobile.1/0.jpg');
  assert.deepEqual([...readFileSync(join(dir, event.frame.file))], [0xff, 0xd8, 1]);
  // In memory, the frame is still named as the journal holds it.
  assert.equal(journal.events[0].frame.file, '0.jpg');
});
