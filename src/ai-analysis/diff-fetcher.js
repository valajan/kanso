const RELEVANT_EXTENSIONS = [
  '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html',
];
const MAX_LINES_PER_FILE = 1000;
const MAX_TOTAL_LINES = 6000;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']);

export function isRelevantFile(filename) {
  if (!filename) return false;
  const base = filename.split('/').pop();
  if (LOCKFILES.has(base)) return false;
  if (/\.(test|spec)\.[^.]+$/.test(base)) return false;
  if (/\.config\.[^.]+$/.test(base)) return false;
  return RELEVANT_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

export function truncatePatch(patch, maxLines = MAX_LINES_PER_FILE) {
  if (!patch) return '';
  const lines = patch.split('\n');
  if (lines.length <= maxLines) return patch;
  const omitted = lines.length - maxLines;
  return lines.slice(0, maxLines).join('\n') + `\n... (${omitted} more lines truncated)`;
}

// Walks a unified-diff patch and returns the line numbers (on the new file side)
// of every `+` line and every context line visible in a hunk. Both are valid
// anchors for a RIGHT-side GitHub review comment: `+` lines for newly introduced
// code, context lines for existing code the LLM wants to annotate in relation to
// the surrounding changes. Removed (`-`) lines are excluded — they don't exist
// on the new side.
export function extractAddedLines(patch) {
  if (!patch) return [];
  const out = [];
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1], 10);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    if (raw.startsWith('-')) {
      // removed line — does not consume a new-side line number
    } else {
      // `+` line or context line — both are valid RIGHT-side comment positions
      out.push(newLine);
      newLine++;
    }
  }
  return out;
}

export async function fetchRelevantDiff({ forge, prNumber, log }) {
  log?.info?.('[ai-analysis] fetching PR file diff');
  const files = await forge.getPullRequestFiles({ prNumber });

  const filtered = files
    .filter((f) => isRelevantFile(f.filename))
    .map((f) => {
      const patch = truncatePatch(f.patch);
      return {
        filename: f.filename,
        status: f.status,
        patch,
        addedLines: extractAddedLines(patch),
      };
    })
    .filter((f) => f.patch);

  // Hard cap on total payload sent to OpenAI, regardless of per-file truncation.
  let remaining = MAX_TOTAL_LINES;
  const capped = [];
  for (const f of filtered) {
    if (remaining <= 0) break;
    const lines = f.patch.split('\n');
    if (lines.length <= remaining) {
      capped.push(f);
      remaining -= lines.length;
    } else {
      const kept = lines.slice(0, remaining).join('\n');
      const omitted = lines.length - remaining;
      const truncatedPatch = `${kept}\n... (${omitted} more lines truncated)`;
      capped.push({ ...f, patch: truncatedPatch, addedLines: extractAddedLines(truncatedPatch) });
      remaining = 0;
    }
  }

  log?.info?.(
    { totalFiles: files.length, relevantFiles: filtered.length, includedFiles: capped.length },
    '[ai-analysis] diff filtered'
  );

  if (capped.length === 0) return null;
  return capped;
}
