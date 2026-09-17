// Validation for the /v1/audit request body.
//
// Everything here runs before any network call, and it is deliberately strict:
// the endpoint is public, so each field is either rejected or normalized into a
// shape the rest of the pipeline can use without re-checking it.
//
// Note what is *not* accepted: branch names, PR titles, author, or any other
// text destined for the report. Those are read back from the forge instead, so
// the only caller-supplied value that ever reaches the rendered comment is the
// preview URL — which the SSRF guard has already vetted.
const SLUG_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SOURCE_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const MAX_CONFIG_CHARS = 64 * 1024;

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function requireString(value, field, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(field, `${field} is required`);
  }
  if (value.length > max) throw new ValidationError(field, `${field} exceeds ${max} characters`);
  return value.trim();
}

// Splits "owner/name" — or "group/subgroup/project" on forges that nest — into
// the owner path and the final repository segment.
export function parseSlug(raw) {
  const slug = requireString(raw, 'repo', { max: 256 });
  const segments = slug.split('/').filter(Boolean);
  if (segments.length < 2) throw new ValidationError('repo', 'repo must be "owner/name"');
  if (!segments.every((s) => SLUG_SEGMENT.test(s))) {
    throw new ValidationError('repo', 'repo contains invalid characters');
  }
  // "." and ".." match the character class but are path traversal in a URL
  // template, so they are excluded explicitly rather than by charset.
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new ValidationError('repo', 'repo contains a relative path segment');
  }
  return { owner: segments.slice(0, -1).join('/'), repo: segments.at(-1), slug: segments.join('/') };
}

export function validateAuditRequest(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body', 'request body must be a JSON object');
  }

  const { owner, repo, slug } = parseSlug(body.repo);

  const prRaw = body.pr ?? body.pull_request;
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0 || pr > 1e7) {
    throw new ValidationError('pr', 'pr must be a positive integer');
  }

  const sha = requireString(body.sha, 'sha', { max: 40 });
  if (!SHA_RE.test(sha)) throw new ValidationError('sha', 'sha must be a 7-40 character hex string');

  const previewUrl = requireString(body.previewUrl ?? body.preview_url, 'previewUrl', { max: 2048 });

  const baseUrlRaw = body.baseUrl ?? body.base_url;
  let baseUrl = null;
  if (baseUrlRaw != null && baseUrlRaw !== '') {
    baseUrl = requireString(baseUrlRaw, 'baseUrl', { max: 2048 });
  }

  // A free-text label rendered into the comment header. Constrained to a
  // conservative character class so it cannot carry markdown or HTML.
  let source = 'Preview';
  if (body.source != null && body.source !== '') {
    source = requireString(body.source, 'source', { max: 40 });
    if (!SOURCE_RE.test(source)) throw new ValidationError('source', 'source may only contain letters, digits, spaces, dots, dashes and underscores');
  }

  let config = null;
  if (body.config != null && body.config !== '') {
    config = requireString(body.config, 'config', { max: MAX_CONFIG_CHARS });
  }

  const forge = body.forge == null || body.forge === '' ? 'github' : requireString(body.forge, 'forge', { max: 32 });

  return { forge, owner, repo, slug, pr, sha: sha.toLowerCase(), previewUrl, baseUrl, source, config };
}

// Extracts the caller's forge token from the Authorization header. The token is
// never logged and never leaves the forge client it is handed to.
export function extractToken(header) {
  if (typeof header !== 'string') throw new ValidationError('authorization', 'Authorization header is required');
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new ValidationError('authorization', 'Authorization must be "Bearer <token>"');
  const token = match[1];
  if (token.length > 512) throw new ValidationError('authorization', 'token is implausibly long');
  return token;
}
