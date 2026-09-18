// What a surface accepts as a page to audit, before anything loads it: a URL
// that parses, over http or https. One rule, in one place, so the CLI, the MCP
// server and anything else pointing the core at a page agree on what a target
// is — and report the same sentence when it is not one.
//
// This is not the SSRF guard (src/security/url-guard.js): that one exists
// because /v1/audit is a public endpoint that must not be aimed at private
// addresses on the operator's behalf. On a developer's own machine,
// http://localhost:4173 is the whole point.
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
