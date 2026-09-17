import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Guards every URL Kanso is asked to load with headless Chrome.
//
// The /v1/audit endpoint accepts a preview URL from the caller, which makes
// that URL the one piece of attacker-controlled input that reaches the network
// stack. Without a guard it is a server-side request forgery primitive: a
// caller could point Kanso at http://169.254.169.254/ (the cloud metadata
// service) or at a service reachable only from inside the deployment's
// network, and read the result back out of the Lighthouse report rendered into
// their own PR comment.
//
// The guard therefore resolves the hostname and rejects the request unless
// *every* address it resolves to is publicly routable.
//
// Residual risk — DNS rebinding: Chrome resolves the name again when it
// actually loads the page, and a hostile authoritative server can answer with
// a public address here and a private one there. We narrow the window by
// re-validating immediately before the audit, but the only complete defence is
// an operator-supplied allowlist (KANSO_ALLOWED_PREVIEW_HOSTS), which pins the
// set of hosts Kanso will ever fetch. Set it in deployments that sit on a
// network with anything worth reaching.
const MAX_URL_LENGTH = 2048;

// Hostname suffixes that resolve inside a private network by convention.
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'];

// IPv4 blocks that must never be fetched, as [network, prefix length] pairs.
// Beyond the obvious private ranges this covers link-local (169.254/16, where
// every major cloud exposes its instance metadata service), carrier-grade NAT,
// the documentation and benchmarking ranges, multicast and the reserved space.
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // RFC1918 private
  ['100.64.0.0', 10],      // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local — cloud instance metadata
  ['172.16.0.0', 12],      // RFC1918 private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // RFC1918 private
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved, includes 255.255.255.255
];

export class UrlGuardError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'UrlGuardError';
    this.reason = reason;
  }
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  // >>> 0 keeps the result unsigned: the top bit is set for 128.0.0.0 and above.
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  if (value == null) return true; // unparseable — refuse rather than guess
  return BLOCKED_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

// Expands any IPv6 form — including "::" compression and a trailing embedded
// IPv4 literal — into its eight 16-bit groups. Returns null if malformed.
export function expandIPv6(address) {
  let text = address.split('%')[0].toLowerCase(); // strip zone index
  let tail = [];

  const lastColon = text.lastIndexOf(':');
  const suffix = text.slice(lastColon + 1);
  if (suffix.includes('.')) {
    const value = ipv4ToInt(suffix);
    if (value == null) return null;
    tail = [value >>> 16, value & 0xffff];
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parse = (part) =>
    part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;

  let groups;
  if (halves.length === 2) {
    const gap = 8 - head.length - rest.length;
    if (gap < 0) return null;
    groups = [...head, ...Array(gap).fill(0), ...rest];
  } else {
    groups = head;
  }

  if (tail.length) groups = [...groups.slice(0, 6), ...tail];
  return groups.length === 8 ? groups : null;
}

export function isPrivateIPv6(address) {
  const g = expandIPv6(address);
  if (!g) return true; // unparseable — refuse rather than guess

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry a v4 address
  // that must be judged on its own merits, or ::ffff:127.0.0.1 walks straight
  // through an IPv6-only check.
  const embedsV4 =
    (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) ||
    (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0);
  if (embedsV4) {
    const v4 = [g[6] >>> 8, g[6] & 0xff, g[7] >>> 8, g[7] & 0xff].join('.');
    return isPrivateIPv4(v4);
  }

  if (g.every((h) => h === 0)) return true;                       // ::
  if (g.slice(0, 7).every((h) => h === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;                    // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;            // 2001:db8::/32 documentation
  return false;
}

export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true;
}

// Matches a hostname against an allowlist entry: either an exact host or a
// "*.example.com" wildcard, which covers subdomains but not the bare apex.
export function hostMatches(hostname, pattern) {
  const host = hostname.toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (!rule) return false;
  if (rule.startsWith('*.')) return host.endsWith(rule.slice(1));
  return host === rule;
}

// Validates a URL for fetching. Resolves to the parsed URL and the addresses it
// resolved to; throws UrlGuardError with a machine-readable `reason` otherwise.
//
// resolver is injectable so the checks can be exercised without touching DNS.
export async function assertSafeUrl(raw, { allowedHosts = [], resolver = lookup } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UrlGuardError('invalid_url', 'URL is required');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new UrlGuardError('invalid_url', `URL exceeds ${MAX_URL_LENGTH} characters`);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError('invalid_url', 'URL is not parseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError('bad_scheme', `Unsupported scheme ${url.protocol} — use http or https`);
  }
  // Credentials in the URL would be forwarded to whatever the host turns out to
  // be, and would leak into the report we render.
  if (url.username || url.password) {
    throw new UrlGuardError('credentials_in_url', 'URL must not embed credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new UrlGuardError('invalid_url', 'URL has no host');

  // An allowlist, when configured, is authoritative: it is the only check that
  // also holds against DNS rebinding, since it constrains the name itself.
  if (allowedHosts.length > 0 && !allowedHosts.some((p) => hostMatches(hostname, p))) {
    throw new UrlGuardError('host_not_allowed', `Host ${hostname} is not in KANSO_ALLOWED_PREVIEW_HOSTS`);
  }

  const literal = isIP(hostname);
  if (!literal) {
    const lower = hostname.toLowerCase();
    if (PRIVATE_SUFFIXES.some((s) => lower.endsWith(s))) {
      throw new UrlGuardError('private_host', `Host ${hostname} resolves inside a private network`);
    }
    // A single-label name ("build-server") only resolves through an internal
    // search domain — never a public preview.
    if (!lower.includes('.')) {
      throw new UrlGuardError('private_host', `Host ${hostname} is not a public domain name`);
    }
  }

  let addresses;
  if (literal) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await resolver(hostname, { all: true });
      addresses = (Array.isArray(resolved) ? resolved : [resolved]).map((r) => r.address);
    } catch {
      throw new UrlGuardError('dns_failure', `Cannot resolve ${hostname}`);
    }
  }

  if (addresses.length === 0) {
    throw new UrlGuardError('dns_failure', `${hostname} resolved to no address`);
  }
  // Every address must be public: a host that answers with one public and one
  // private address would otherwise be fetched over the private one.
  const blocked = addresses.find((a) => isPrivateAddress(a));
  if (blocked) {
    throw new UrlGuardError('private_address', `${hostname} resolves to non-public address ${blocked}`);
  }

  return { url, addresses };
}

// Parses the operator allowlist from the environment.
export function parseAllowedHosts(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
