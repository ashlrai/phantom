import type { FleetRunsV1 } from '../verse/fleet-runs-types.js';
import type { RemotePushDetail } from './remote-push.js';
import { redactHomePaths, scrubSecrets } from '../util/scrub.js';

/** Scrub before clipping, so truncation cannot hide a secret's identifying prefix. */
export function sanitizePushDetail(value: string): string {
  const clean = Array.from(value).filter((char) => {
    const code = char.charCodeAt(0);
    return code > 31 && (code < 127 || code > 159);
  }).join('');
  return redactHomePaths(scrubSecrets(redactHomePaths(clean)))
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/~(?:[/\\][^\s,;]*)?/g, '[REDACTED]')
    .slice(0, 120);
}

export interface PushIntent extends RemotePushDetail { kind: 'fleet-merged' | 'fleet-lane-held' }
export type PushFleetSnapshot = Pick<FleetRunsV1, 'mergesLastHour' | 'lanes' | 'claudeLane'>;

/** Validate the fields used by the diff; unavailable reads must retain the baseline. */
export function validPushFleet(value: unknown): value is PushFleetSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as PushFleetSnapshot;
  return (row.claudeLane === null || typeof row.claudeLane === 'string')
    && Array.isArray(row.lanes) && row.lanes.every((lane) => lane && typeof lane.lane === 'string'
      && typeof lane.held === 'boolean' && (lane.heldReason === null || typeof lane.heldReason === 'string'))
    && !!row.mergesLastHour && Array.isArray(row.mergesLastHour.items)
    && row.mergesLastHour.items.every((item) => item && typeof item.repo === 'string'
      && Number.isSafeInteger(item.number) && item.number > 0 && typeof item.title === 'string');
}

export function diffFleetForPush(previous: PushFleetSnapshot | null, current: PushFleetSnapshot): PushIntent[] {
  if (!previous) return [];
  const intents: PushIntent[] = [];
  const key = (item: PushFleetSnapshot['mergesLastHour']['items'][number]) => `${item.repo}#${item.number}`;
  const known = new Set(previous.mergesLastHour.items.map(key));
  // Preserve snapshot order: the contract has no per-merge timestamp.
  const added = current.mergesLastHour.items.filter((item) => {
    if (known.has(key(item))) return false;
    known.add(key(item));
    return true;
  });
  if (added.length) intents.push({ kind: 'fleet-merged', count: added.length,
    detail: sanitizePushDetail(`#${added[0].number} ${sanitizePushDetail(added[0].title).slice(0, 80)}`) });
  const held = current.lanes.find((lane) => lane.held
    && previous.lanes.some((old) => old.lane === lane.lane && !old.held));
  if (held) intents.push({ kind: 'fleet-lane-held',
    detail: sanitizePushDetail(`${held.lane}: ${held.heldReason || 'held'}`) });
  else if (current.claudeLane?.startsWith('down') && !previous.claudeLane?.startsWith('down')) {
    intents.push({ kind: 'fleet-lane-held', detail: sanitizePushDetail(`claude: ${current.claudeLane}`) });
  }
  return intents;
}
