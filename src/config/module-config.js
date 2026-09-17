import { deepMerge, isPlainObject } from './merge.js';

// A module's own configuration: the section of .kanso.yml that carries its id.
//
//   performance:
//     budgets:
//       lcp: 2500
//   accessibility:
//     fail_on: serious
//
// One section per module is what keeps a new concern from having to invent a
// key nobody else has taken: `fail_on` means one thing under accessibility and
// could mean another under SEO. The core resolves the section and hands it to
// the module, which never sees the rest of the file.
//
// Performance came first and its keys still live at the root, where every
// .kanso.yml written so far keeps them. Those are read as the defaults of its
// section, so an old file keeps judging a page by the same numbers, and a
// section wins key by key over the root.
//
// `runs` is deliberately not one of them: it counts page loads, and one load
// feeds every module, so it stays a property of the audit rather than of any
// module in it.
const LEGACY_ROOT_KEYS = { performance: ['budgets'] };

export function moduleConfig(config = {}, id) {
  const legacy = {};
  for (const key of LEGACY_ROOT_KEYS[id] ?? []) {
    if (config?.[key] !== undefined) legacy[key] = config[key];
  }

  const section = config?.[id];
  return deepMerge(legacy, isPlainObject(section) ? section : {});
}
