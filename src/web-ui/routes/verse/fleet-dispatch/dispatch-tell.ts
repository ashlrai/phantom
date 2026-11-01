import type { LaneVerdict } from './fleet-dispatch-model.js';

const tellKinds: ReadonlySet<LaneVerdict['kind']> = new Set(['starved', 'stalled', 'down', 'held']);

export function dispatchTellKinds(): ReadonlySet<LaneVerdict['kind']> {
  return tellKinds;
}

export function dispatchTellPrefill(v: Pick<LaneVerdict, 'lane' | 'kind' | 'headline' | 'free' | 'stall'>): string {
  const text = v.kind === 'stalled' && v.stall
    ? `Lane ${v.lane} has ${v.stall.queued} queued and ${v.free} free slots but nothing launched for ${v.stall.duration}. Find out why and launch them.`
    : `Re lane ${v.lane} (${v.kind}, ${v.free} free slots): ${v.headline}. `;
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
