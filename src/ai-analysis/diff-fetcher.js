const RELEVANT_EXTENSIONS = [
  '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html',
];
const MAX_LINES_PER_FILE = 150;
const MAX_TOTAL_LINES = 1500;
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
// of every `+` line. These are the only positions a RIGHT-side PR review comment
// can anchor on for code the PR introduced. Context and removed lines are not
// candidates: pointing at context is rarely actionable, and `-` lines do not
// exist on the new side at all.
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
    if (raw.startsWith('+')) {
      out.push(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // removed line — does not consume a new-side line number
    } else {
      // context line (leading space, or our truncation marker) — advances cursor
      newLine++;
    }
  }
  return out;
}

export async function fetchRelevantDiff({ octokit, owner, repo, prNumber, log }) {
  log?.info?.('[ai-analysis] fetching PR file diff');
  const { data: files } = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    { owner, repo, pull_number: prNumber, per_page: 100 }
  );

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
