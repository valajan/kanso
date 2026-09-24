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
