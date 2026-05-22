import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewStore } from '../state.js';

test('stores and clears preview URLs', () => {
  const store = new PreviewStore();
  store.setPreviewUrl(1, 'https://preview.example');
  assert.equal(store.getPreviewUrl(1), 'https://preview.example');
  store.clearPreviewUrl(1);
  assert.equal(store.getPreviewUrl(1), undefined);
});

test('takePending removes the entry and reports whether it existed', () => {
  const store = new PreviewStore();
  assert.equal(store.takePending(2), false);
  store.markPending(2, { owner: 'o', repo: 'r' });
  assert.equal(store.isPending(2), true);
  assert.equal(store.takePending(2), true);
  assert.equal(store.isPending(2), false);
});

test('takeWaitingComment returns the id once and forgets it', () => {
  const store = new PreviewStore();
  assert.equal(store.takeWaitingComment(3), undefined);
  store.setWaitingComment(3, 999);
  assert.equal(store.takeWaitingComment(3), 999);
  assert.equal(store.takeWaitingComment(3), undefined);
});

test('dedup keys are remembered after markSeen', () => {
  const store = new PreviewStore();
  assert.equal(store.hasSeen('checkrun:42'), false);
  store.markSeen('checkrun:42');
  assert.equal(store.hasSeen('checkrun:42'), true);
});
