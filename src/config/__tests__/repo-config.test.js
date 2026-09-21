import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepoConfig, mergeConfig, parseRepoConfig } from '../repo-config.js';

const staticConfig = {
  budgets: { performance: 90, lcp: 2500, tbt: 200 },
  accessibility: { fail_on: 'serious' },
  runs: 1,
};

test('mergeConfig overrides budgets metric by metric', () => {
  const merged = mergeConfig(staticConfig, { budgets: { lcp: 2000 }, runs: 3 });
  assert.deepEqual(merged.budgets, { performance: 90, lcp: 2000, tbt: 200 });
  assert.equal(merged.runs, 3);
  assert.deepEqual(merged.accessibility, { fail_on: 'serious' });
});

// A module's section merges the same way the budgets do: a repo setting one
// key of it keeps the defaults for the rest.
test('mergeConfig merges a module section key by key', () => {
  const base = { accessibility: { fail_on: 'serious', ignore: ['color-contrast'] } };
  const merged = mergeConfig(base, { accessibility: { fail_on: 'critical' } });
  assert.deepEqual(merged.accessibility, { fail_on: 'critical', ignore: ['color-contrast'] });
});

test('parseRepoConfig merges a YAML document onto the defaults', () => {
  const merged = parseRepoConfig('budgets:\n  lcp: 1800\nruns: 3\n', staticConfig);
  assert.equal(merged.budgets.lcp, 1800);
  assert.equal(merged.budgets.performance, 90);
  assert.equal(merged.runs, 3);
});

test('parseRepoConfig treats an empty document as no override', () => {
  assert.equal(parseRepoConfig('', staticConfig), staticConfig);
  assert.deepEqual(parseRepoConfig('# just a comment\n', staticConfig), staticConfig);
});

test('parseRepoConfig refuses a non-mapping document', () => {
  assert.throws(() => parseRepoConfig('- a\n- b\n', staticConfig), /mapping/);
  assert.throws(() => parseRepoConfig('just a string', staticConfig), /mapping/);
});

// The API accepts this file from the caller, so its size has to be bounded.
test('parseRepoConfig refuses an oversized document', () => {
  assert.throws(() => parseRepoConfig('x'.repeat(70_000), staticConfig), /exceeds/);
});

// Merging by assignment would make `__proto__` set the merged config's
// prototype instead of adding a key — and this file arrives from a caller.
test('parseRepoConfig drops a __proto__ key instead of merging it', () => {
  const merged = parseRepoConfig('__proto__:\n  budgets:\n    lcp: 1\n', staticConfig);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.budgets.lcp, 2500, 'the defaults are untouched');
});

// js-yaml's core schema builds plain data only — no custom tags are honoured.
test('parseRepoConfig does not honour custom YAML tags', () => {
  assert.throws(() => parseRepoConfig('budgets: !!js/function "function(){}"', staticConfig));
});

test('an inline config is used without touching the forge', async () => {
  const forge = {
    slug: 'acme/site',
    getFileContent: async () => assert.fail('must not fetch when a config was supplied'),
  };
  const config = await loadRepoConfig({ forge, staticConfig, inlineConfig: 'budgets:\n  lcp: 1500\n' });
  assert.equal(config.budgets.lcp, 1500);
});

test('an invalid inline config falls back to the defaults with a warning', async () => {
  const warnings = [];
  const forge = { slug: 'acme/site', getFileContent: async () => assert.fail('must not fetch') };
  const config = await loadRepoConfig({
    forge, staticConfig, inlineConfig: '- not a mapping', log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(config, staticConfig);
  assert.equal(warnings.length, 1);
});

test('without an inline config the file is fetched through the forge', async () => {
  const forge = {
    slug: 'acme/site',
    getFileContent: async ({ path, ref }) => {
      assert.equal(path, '.kanso.yml');
      assert.equal(ref, 'abc123');
      return 'runs: 3\n';
    },
  };
  const config = await loadRepoConfig({ forge, staticConfig, ref: 'abc123' });
  assert.equal(config.runs, 3);
});

test('a repo with no .kanso.yml gets the static defaults', async () => {
  const forge = { slug: 'acme/site', getFileContent: async () => null };
  assert.equal(await loadRepoConfig({ forge, staticConfig }), staticConfig);
});

test('an invalid .kanso.yml in the repo falls back rather than failing the audit', async () => {
  const warnings = [];
  const forge = { slug: 'acme/site', getFileContent: async () => '- broken' };
  const config = await loadRepoConfig({ forge, staticConfig, log: { warn: (m) => warnings.push(m) } });
  assert.equal(config, staticConfig);
  assert.equal(warnings.length, 1);
});
