import type { LaneVerdict } from './fleet-dispatch-model.js';

const tellKinds: ReadonlySet<LaneVerdict['kind']> = new Set(['starved', 'down', 'held']);

export function dispatchTellKinds(): ReadonlySet<LaneVerdict['kind']> {
  return tellKinds;
}

export function dispatchTellPrefill(v: Pick<LaneVerdict, 'lane' | 'kind' | 'headline' | 'free'>): string {
  const text = `Re lane ${v.lane} (${v.kind}, ${v.free} free slots): ${v.headline}. `;
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
