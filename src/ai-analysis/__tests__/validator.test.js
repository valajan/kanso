import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis } from '../validator.js';

const diff = [
  { filename: 'src/Hero.jsx', addedLines: [12, 13, 47] },
  { filename: 'styles/main.css', addedLines: [88] },
];

function captureLog() {
  const calls = [];
  return { calls, warn: (obj, msg) => calls.push({ obj, msg }) };
}

test('parses valid JSON with summary only', () => {
  const out = validateAnalysis(JSON.stringify({ summary: 'Looks like a large image.' }), diff, {});
  assert.equal(out.summary, 'Looks like a large image.');
  assert.deepEqual(out.comments, []);
});

test('keeps comments whose (file, line) match an added line', () => {
  const raw = JSON.stringify({
    summary: 'Heavy banner.',
    comments: [
      { file: 'src/Hero.jsx', line: 12, body: 'This image is too big.' },
      { file: 'styles/main.css', line: 88, body: 'Background image is huge.' },
    ],
  });
  const out = validateAnalysis(raw, diff, {});
  assert.equal(out.comments.length, 2);
  assert.equal(out.comments[0].file, 'src/Hero.jsx');
  assert.equal(out.comments[0].line, 12);
});

test('drops comments with an unknown file', () => {
  const log = captureLog();
  const raw = JSON.stringify({
    summary: 's',
    comments: [
      { file: 'src/Hero.jsx', line: 12, body: 'ok' },
      { file: 'src/Hallucinated.jsx', line: 5, body: 'bad' },
    ],
  });
  const out = validateAnalysis(raw, diff, { log });
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].file, 'src/Hero.jsx');
  assert.equal(log.calls.length, 1);
});

test('drops comments whose line is not an added line', () => {
  const log = captureLog();
  const raw = JSON.stringify({
    summary: 's',
    comments: [
      { file: 'src/Hero.jsx', line: 999, body: 'bad line' },
      { file: 'src/Hero.jsx', line: 47, body: 'good' },
    ],
  });
  const out = validateAnalysis(raw, diff, { log });
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].line, 47);
});

test('drops malformed comments (missing file/line/body, non-integer line)', () => {
  const raw = JSON.stringify({
    summary: 's',
    comments: [
      { line: 12, body: 'no file' },
      { file: 'src/Hero.jsx', body: 'no line' },
      { file: 'src/Hero.jsx', line: 12 }, // no body
      { file: 'src/Hero.jsx', line: 12, body: '   ' }, // empty body
      { file: 'src/Hero.jsx', line: 12.5, body: 'non-integer' },
      { file: 'src/Hero.jsx', line: 13, body: 'ok' },
    ],
  });
  const out = validateAnalysis(raw, diff, {});
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].body, 'ok');
});

test('throws when JSON is malformed', () => {
  assert.throws(
    () => validateAnalysis('not json at all', diff, {}),
    /invalid JSON/i
  );
});

test('throws when summary is missing or empty', () => {
  assert.throws(
    () => validateAnalysis(JSON.stringify({ comments: [] }), diff, {}),
    /empty summary/i
  );
  assert.throws(
    () => validateAnalysis(JSON.stringify({ summary: '   ' }), diff, {}),
    /empty summary/i
  );
});

test('strips a ```json code fence if the model wraps its output', () => {
  const wrapped = '```json\n{"summary":"hello"}\n```';
  const out = validateAnalysis(wrapped, diff, {});
  assert.equal(out.summary, 'hello');
});

test('applies sanitize to summary and comment bodies', () => {
  const sanitize = (s) => s.replace(/UNSAFE/g, 'SAFE');
  const raw = JSON.stringify({
    summary: 'this is UNSAFE',
    comments: [{ file: 'src/Hero.jsx', line: 12, body: 'also UNSAFE' }],
  });
  const out = validateAnalysis(raw, diff, { sanitize });
  assert.equal(out.summary, 'this is SAFE');
  assert.equal(out.comments[0].body, 'also SAFE');
});

test('tolerates missing comments array', () => {
  const out = validateAnalysis(JSON.stringify({ summary: 's' }), diff, {});
  assert.deepEqual(out.comments, []);
});

test('tolerates non-array comments field by dropping it', () => {
  const out = validateAnalysis(JSON.stringify({ summary: 's', comments: 'oops' }), diff, {});
  assert.deepEqual(out.comments, []);
});
