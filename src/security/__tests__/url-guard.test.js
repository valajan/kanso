import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeUrl,
  expandIPv6,
  hostMatches,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  parseAllowedHosts,
  UrlGuardError,
} from '../url-guard.js';

const publicResolver = async () => [{ address: '93.184.216.34' }];
const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address }));

async function reasonFor(url, options = {}) {
  try {
    await assertSafeUrl(url, { resolver: publicResolver, ...options });
    return null;
  } catch (err) {
    assert.ok(err instanceof UrlGuardError, `expected UrlGuardError, got ${err}`);
    return err.reason;
  }
}

// --- IPv4 ranges ------------------------------------------------------------

test('isPrivateIPv4 blocks every reserved and private range', () => {
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isPrivateIPv4(ip), true, `${ip} should be blocked`);
  }
});

test('isPrivateIPv4 allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '172.15.255.255', '99.99.99.99']) {
    assert.equal(isPrivateIPv4(ip), false, `${ip} should be allowed`);
  }
});

test('isPrivateIPv4 refuses anything it cannot parse', () => {
  assert.equal(isPrivateIPv4('not-an-ip'), true);
  assert.equal(isPrivateIPv4('1.2.3'), true);
  assert.equal(isPrivateIPv4('1.2.3.999'), true);
});

// --- IPv6 ranges ------------------------------------------------------------

test('expandIPv6 expands compressed and v4-embedded forms', () => {
  assert.deepEqual(expandIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('2001:db8::1'), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  assert.equal(expandIPv6('1::2::3'), null);
});

test('isPrivateIPv6 blocks loopback, ULA, link-local and multicast', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isPrivateIPv6(ip), true, `${ip} should be blocked`);
  }
});

// An IPv6-only check that forgets v4-mapped addresses lets ::ffff:169.254.169.254
// reach the metadata service, so this case is the one that matters most.
test('isPrivateIPv6 judges v4-mapped and NAT64 addresses on their embedded v4', () => {
  assert.equal(isPrivateIPv6('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIPv6('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateIPv6('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIPv6('64:ff9b::169.254.169.254'), true);
  assert.equal(isPrivateIPv6('::ffff:93.184.216.34'), false);
});

test('isPrivateIPv6 allows public v6 addresses', () => {
  assert.equal(isPrivateIPv6('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIPv6('2a00:1450:4007::200e'), false);
});

test('isPrivateAddress refuses hostnames — only literals are judged here', () => {
  assert.equal(isPrivateAddress('example.com'), true);
});

// --- URL admission ----------------------------------------------------------

test('accepts a plain https URL resolving to a public address', async () => {
  const { url, addresses } = await assertSafeUrl('https://preview.example.com/path', { resolver: publicResolver });
  assert.equal(url.hostname, 'preview.example.com');
  assert.deepEqual(addresses, ['93.184.216.34']);
});

test('rejects non-http schemes', async () => {
  assert.equal(await reasonFor('file:///etc/passwd'), 'bad_scheme');
  assert.equal(await reasonFor('gopher://example.com/'), 'bad_scheme');
  assert.equal(await reasonFor('javascript:alert(1)'), 'bad_scheme');
});

test('rejects credentials embedded in the URL', async () => {
  assert.equal(await reasonFor('https://user:pass@example.com/'), 'credentials_in_url');
});

test('rejects unparseable and oversized URLs', async () => {
  assert.equal(await reasonFor('not a url'), 'invalid_url');
  assert.equal(await reasonFor(''), 'invalid_url');
  assert.equal(await reasonFor(null), 'invalid_url');
  assert.equal(await reasonFor(`https://example.com/${'a'.repeat(2100)}`), 'invalid_url');
});

test('rejects the cloud metadata service by literal address', async () => {
  assert.equal(await reasonFor('http://169.254.169.254/latest/meta-data/'), 'private_address');
  assert.equal(await reasonFor('http://[::ffff:169.254.169.254]/'), 'private_address');
});

test('rejects localhost and private literals', async () => {
  assert.equal(await reasonFor('http://127.0.0.1:8080/'), 'private_address');
  assert.equal(await reasonFor('http://192.168.1.1/'), 'private_address');
  assert.equal(await reasonFor('http://[::1]:3000/'), 'private_address');
});

// The attack this exists for: a public name whose DNS answer points inside.
test('rejects a public hostname that resolves to a private address', async () => {
  assert.equal(await reasonFor('https://evil.example.com/', { resolver: resolveTo('169.254.169.254') }), 'private_address');
});

// A host answering with one good and one bad address would otherwise be fetched
// over whichever the OS picked.
test('rejects when any resolved address is private', async () => {
  assert.equal(
    await reasonFor('https://evil.example.com/', { resolver: resolveTo('93.184.216.34', '10.0.0.5') }),
    'private_address'
  );
});

test('rejects internal-only hostname shapes', async () => {
  assert.equal(await reasonFor('http://buildserver/'), 'private_host');
  assert.equal(await reasonFor('http://db.internal/'), 'private_host');
  assert.equal(await reasonFor('http://printer.local/'), 'private_host');
  assert.equal(await reasonFor('http://app.localhost/'), 'private_host');
});

test('reports a resolution failure distinctly from a blocked address', async () => {
  const failing = async () => { throw new Error('ENOTFOUND'); };
  assert.equal(await reasonFor('https://nope.example.com/', { resolver: failing }), 'dns_failure');
  assert.equal(await reasonFor('https://nope.example.com/', { resolver: async () => [] }), 'dns_failure');
});

// --- allowlist --------------------------------------------------------------

test('hostMatches supports exact hosts and wildcard subdomains', () => {
  assert.equal(hostMatches('preview.netlify.app', '*.netlify.app'), true);
  assert.equal(hostMatches('netlify.app', '*.netlify.app'), false);
  assert.equal(hostMatches('site.example.com', 'site.example.com'), true);
  assert.equal(hostMatches('other.example.com', 'site.example.com'), false);
  assert.equal(hostMatches('SITE.EXAMPLE.COM', 'site.example.com'), true);
});

test('an allowlist rejects every host outside it', async () => {
  const allowedHosts = ['*.netlify.app'];
  assert.equal(await reasonFor('https://elsewhere.example.com/', { allowedHosts }), 'host_not_allowed');
  assert.equal(await reasonFor('https://pr-3.netlify.app/', { allowedHosts }), null);
});

test('parseAllowedHosts splits and trims, tolerating an empty value', () => {
  assert.deepEqual(parseAllowedHosts('a.com, *.b.com ,'), ['a.com', '*.b.com']);
  assert.deepEqual(parseAllowedHosts(''), []);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});
