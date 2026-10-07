import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pictures } from '../evidence.js';

// Which part of the page a finding's pictures show, and where each element is
// in them. Taking them needs a Chrome (test/probes/probes.test.mjs).
const PHONE = { viewport: { width: 412, height: 823 }, document: { width: 412, height: 5000 } };
const at = (selector, x, y, width, height) => ({ selector, rect: { x, y, width, height } });

test('elements close to one another share a picture, numbered as the finding lists them', () => {
  const [one, ...rest] = pictures([at('b', 20, 1260, 100, 40), at('a', 20, 1200, 100, 40)], PHONE);

  assert.deepEqual(rest, []);
  // The two of them in the middle of the picture: 1250 is their middle.
  assert.deepEqual(one.clip, { x: 0, y: 839, width: 412, height: 823 });
  assert.deepEqual(one.boxes.map(({ n, selector, rect }) => [n, selector, rect.y]), [[2, 'a', 361], [1, 'b', 421]]);
});

test('elements a screen apart get a picture each, from the top of the page down', () => {
  const shots = pictures([at('low', 0, 3000, 50, 50), at('high', 0, 100, 50, 50)], PHONE);

  assert.deepEqual(shots.map(({ clip, boxes }) => [clip.y, boxes.map(({ n }) => n)]), [[0, [2]], [2614, [1]]]);
});

test('a picture stays on the page: at its top, at its bottom, and no taller than it', () => {
  const short = { viewport: { width: 1350, height: 940 }, document: { width: 1350, height: 400 } };
  assert.deepEqual(pictures([at('a', 0, 10, 50, 50)], short)[0].clip, { x: 0, y: 0, width: 1350, height: 400 });
  assert.equal(pictures([at('a', 0, 4990, 50, 10)], PHONE)[0].clip.y, 5000 - 823);
});

test('an element taller than a picture is shown from its top', () => {
  const [shot] = pictures([at('main', 0, 1000, 412, 3000)], PHONE);
  assert.equal(shot.clip.y, 1000);
  assert.equal(shot.boxes[0].rect.y, 0);
});

test('a picture is as wide as what it shows, when the page is wider than the screen', () => {
  const wide = { viewport: { width: 320, height: 640 }, document: { width: 416, height: 640 } };
  assert.equal(pictures([at('box', 16, 100, 400, 20)], wide)[0].clip.width, 416);
  assert.equal(pictures([at('p', 16, 100, 200, 20)], wide)[0].clip.width, 320);
});

test('an element behind something else keeps saying so in its picture', () => {
  const [shot] = pictures([at('h1', 20, 100, 300, 40), { ...at('img', 20, 200, 40, 40), coveredBy: 'div.banner' }], PHONE);
  assert.deepEqual(shot.boxes.map(({ n, selector, coveredBy }) => [n, selector, coveredBy ?? null]), [[1, 'h1', null], [2, 'img', 'div.banner']]);
});

test('no element, no picture', () => {
  assert.deepEqual(pictures([], PHONE), []);
});
