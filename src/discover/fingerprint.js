import { createHash } from 'node:crypto';

// What makes two readings of a page the same state: the interactive elements a
// visitor can see — each by role, name and ARIA state, not by position — and
// the dialogs open. Computed by code, never asked of a model: telling a state
// already seen from a new one is a comparison, not a judgment.
//
// Position, scroll and text are left out on purpose: a carousel that turns, a
// clock, a counter would make every reading a new state. What is left changes
// when a menu opens (its items appear), a tab is chosen (`selected` moves), a
// panel expands (`expanded` flips), a modal opens (a dialog, and the page
// behind it gone inert).
//
// Text is the second, weaker signal (`contentDiff`): a tab switcher built of
// divs swaps a panel's text and nothing a screen reader would call a control.

export function fingerprint({ elements, dialogs }) {
  const parts = [
    ...elements.map(part),
    ...dialogs.map((name) => `dialog|${name}`),
  ].sort();
  const key = createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
  return { key, parts };
}

// One element as the fingerprint counts it: `button|Menu|expanded=true`.
export function part({ role, name, states }) {
  const state = Object.keys(states).sort().filter((k) => k !== 'haspopup').map((k) => `${k}=${states[k]}`).join(',');
  return `${role}|${name}|${state}`;
}

// What changed from `before` to `after`, as the parts that appeared and the
// ones that went — a multiset difference: two "Close" buttons, then one, is a
// change.
export function diff(before, after) {
  return {
    appeared: subtract(after.parts, before.parts),
    disappeared: subtract(before.parts, after.parts),
  };
}

// The lines of text that changed between two snapshots, less the ones known to
// change on their own — `volatile`, the lines two loads of the page with
// nothing clicked did not agree on.
export function contentDiff(before, after, volatile = new Set()) {
  const keep = (lines) => lines.filter((l) => !volatile.has(l));
  return {
    appeared: subtract(keep(after.lines), keep(before.lines)),
    disappeared: subtract(keep(before.lines), keep(after.lines)),
  };
}

// The lines two loads of the same page disagree on.
export function volatileLines(a, b) {
  const { appeared, disappeared } = contentDiff(a, b);
  return new Set([...appeared, ...disappeared]);
}

function subtract(from, what) {
  const left = new Map();
  for (const p of what) left.set(p, (left.get(p) ?? 0) + 1);
  return from.filter((p) => {
    const n = left.get(p) ?? 0;
    if (n > 0) {
      left.set(p, n - 1);
      return false;
    }
    return true;
  });
}
