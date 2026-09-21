// What a surface accepts as a page to audit, before anything loads it: a URL
// that parses, over http or https. One rule, in one place, so the CLI, the MCP
// server and anything else pointing the core at a page agree on what a target
// is — and report the same sentence when it is not one.
//
// There is deliberately no SSRF guard here. Kanso runs where the code is — a
// developer's machine or a CI runner — and audits what its own operator points
// it at: http://localhost:4173 is the whole point, not something to refuse.
export function parseTarget(value, label = 'url') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidTarget(`${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidTarget(`${label} must be http or https: ${value}`);
  }
  return parsed.href;
}

// Signals a target the caller named wrong. Each surface reports it in its own
// terms — a usage error on the command line, invalid params over JSON-RPC.
export class InvalidTarget extends Error {}
