// Strips a leading ```json (or ```) fence and matching trailing ``` if the
// model wraps its JSON despite being told not to. response_format:json_object
// should prevent this, but we belt-and-suspenders for older / quirky models.
function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

// Parses the model's JSON output and keeps only comments anchored on a
// (file, line) pair that exists on the right side of the diff we sent.
// Anything the model invents — wrong filename, wrong line, missing body —
// is dropped (and logged), never forwarded to GitHub.
export function validateAnalysis(rawJson, diff, { sanitize, log } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawJson));
  } catch (err) {
    throw new Error(`AI returned invalid JSON: ${err.message}`);
  }

  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('AI returned empty summary');

  const linesByFile = new Map(diff.map((f) => [f.filename, new Set(f.addedLines)]));
  const safeSanitize = sanitize ?? ((s) => s);

  const dropped = [];
  const rawComments = Array.isArray(parsed.comments) ? parsed.comments : [];
  const comments = [];

  for (const c of rawComments) {
    if (typeof c?.file !== 'string') { dropped.push({ reason: 'missing file', c }); continue; }
    if (!isInt(c?.line)) { dropped.push({ reason: 'missing or non-integer line', c }); continue; }
    if (typeof c?.body !== 'string' || c.body.trim().length === 0) {
      dropped.push({ reason: 'missing body', c });
      continue;
    }
    const valid = linesByFile.get(c.file);
    if (!valid) { dropped.push({ reason: 'unknown file', file: c.file }); continue; }
    if (!valid.has(c.line)) { dropped.push({ reason: 'line not in added lines', file: c.file, line: c.line }); continue; }
    comments.push({
      file: c.file,
      line: c.line,
      body: safeSanitize(c.body.trim()),
    });
  }

  if (dropped.length > 0) {
    log?.warn?.({ dropped }, '[ai-analysis] dropped invalid comments');
  }

  return { summary: safeSanitize(summary), comments };
}
