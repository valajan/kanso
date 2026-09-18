import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleConfig } from '../module-config.js';

test('a module reads its own section and nothing else', () => {
  const config = {
    runs: 3,
    accessibility: { fail_on: 'critical' },
    performance: { budgets: { lcp: 2000 } },
  };

  assert.deepEqual(moduleConfig(config, 'accessibility'), { fail_on: 'critical' });
  assert.deepEqual(moduleConfig(config, 'performance'), { budgets: { lcp: 2000 } });
});

// Every .kanso.yml written before the sections existed keeps its budgets at the
// root, and has to keep judging a page by the same numbers.
test('performance still reads the budgets at the root of the file', () => {
  const config = { budgets: { performance: 90, lcp: 2500 } };
  assert.deepEqual(moduleConfig(config, 'performance').budgets, { performance: 90, lcp: 2500 });
});

test('the section wins over the root, budget by budget', () => {
  const config = {
    budgets: { performance: 90, lcp: 2500, tbt: 200 },
    performance: { budgets: { lcp: 1800 } },
  };

  assert.deepEqual(moduleConfig(config, 'performance').budgets, { performance: 90, lcp: 1800, tbt: 200 });
});

test('a module with no section of its own gets an empty config', () => {
  assert.deepEqual(moduleConfig({ runs: 3 }, 'accessibility'), {});
  assert.deepEqual(moduleConfig(undefined, 'accessibility'), {});
});

// A section that is not a mapping is a mistake in the file, not a reason to
// hand a module something it cannot read.
test('a section that is not a mapping is ignored', () => {
  assert.deepEqual(moduleConfig({ accessibility: 'serious' }, 'accessibility'), {});
  assert.deepEqual(moduleConfig({ accessibility: ['serious'] }, 'accessibility'), {});
});
