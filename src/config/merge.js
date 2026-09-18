// Deep-merges configuration objects, key by key. A section a caller only half
// restates keeps the defaults for everything it left out, at any depth, which
// is what lets a .kanso.yml set one budget without repeating the other four.
//
// Anything that is not a plain object — a number, a string, an array, null —
// replaces what it overrides rather than merging into it.
//
// `__proto__` is dropped rather than copied: assigning it would set the merged
// object's prototype instead of adding a key, and a .kanso.yml is parsed
// straight from a caller's request on the API path. js-yaml keeps it as an
// ordinary key, so it only becomes one here.
export function deepMerge(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key === '__proto__') continue;
    merged[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
