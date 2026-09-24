import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStopped, stoppedBy, writeKey } from '../guards.js';

// What the guards stopped that a click did, told from what the page does on its
// own. The net itself is tested against a real Chrome (test/discover/).

const PAGE = 'https://shop.test/basket';
const write = (url, method = 'POST') => ({ kind: 'write', method, url });

test('a write to where the page also writes unprompted is its own noise, whatever the query', () => {
  const unprompted = new Set([writeKey(write('https://shop.test/cdn-cgi/rum?t=1'))]);
  assert.deepEqual(stoppedBy([write('https://shop.test/cdn-cgi/rum?t=2')], unprompted), []);
});

test('a write the page does not make unprompted is the click\'s, even beside its beacons', () => {
  const unprompted = new Set([writeKey(write('https://shop.test/cdn-cgi/rum'))]);
  const tip = write('https://shop.test/api/payment/tip');
  assert.deepEqual(stoppedBy([write('https://shop.test/cdn-cgi/rum'), tip], unprompted), [tip]);
});

test('the same address written with another method is not the beacon', () => {
  const unprompted = new Set([writeKey(write('https://shop.test/api/basket'))]);
  const removal = write('https://shop.test/api/basket', 'DELETE');
  assert.deepEqual(stoppedBy([removal], unprompted), [removal]);
});

test('a navigation, a window or a dialog is never noise, wherever the page writes', () => {
  const blocked = [
    { kind: 'navigation', url: 'https://shop.test/next' },
    { kind: 'window', url: null },
    { kind: 'dialog', type: 'confirm', message: 'Clear all?' },
  ];
  const unprompted = new Set([writeKey(write('https://shop.test/next'))]);
  assert.deepEqual(stoppedBy(blocked, unprompted), blocked);
});

test('what was stopped is named in a few words, by path on the page\'s own site and by host elsewhere', () => {
  assert.deepEqual([
    write('https://shop.test/api/payment/tip?x=1'),
    write('https://pay.example.com/v1/sessions', 'PUT'),
    { kind: 'navigation', url: 'https://shop.test/next.html' },
    { kind: 'window', url: null },
    { kind: 'dialog', type: 'confirm', message: 'Sure?' },
  ].map((b) => describeStopped(b, PAGE)), [
    'POST /api/payment/tip', 'PUT pay.example.com/v1/sessions', 'navigation to /next.html', 'a window', 'confirm',
  ]);
});
