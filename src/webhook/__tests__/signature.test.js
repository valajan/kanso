import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSignatureVerifier } from '../signature.js';

const SECRET = 'test-secret';
const verify = createSignatureVerifier(SECRET);
const body = Buffer.from('{"hello":"world"}');

function sign(buf, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
}

test('accepts a signature computed with the matching secret', () => {
  assert.equal(verify(body, sign(body)), true);
});

test('rejects a signature computed with a different secret', () => {
  assert.equal(verify(body, sign(body, 'wrong-secret')), false);
});

test('rejects a missing or non-string signature header', () => {
  assert.equal(verify(body, undefined), false);
  assert.equal(verify(body, null), false);
});

test('rejects a header of the wrong length without throwing', () => {
  assert.equal(verify(body, 'sha256=deadbeef'), false);
});
