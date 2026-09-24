import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// What a record holds: one journal per load, named by src/probes/journal.js,
// and the result. The CLI and the MCP server keep one the same way.
export const RECORD_RESULT = 'audit.json';
const RECORD_JOURNAL = /^(current|baseline)\.(mobile|desktop)\.\d+\.jsonl$/;

// A record directory kept from an earlier audit loses what that audit wrote —
// a third run's journal would otherwise sit beside a one-run audit's — and
// nothing else in it.
export function clearRecord(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name === RECORD_RESULT || RECORD_JOURNAL.test(name)) rmSync(join(dir, name));
  }
}
