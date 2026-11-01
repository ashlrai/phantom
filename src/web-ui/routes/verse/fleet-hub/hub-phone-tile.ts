import { lastUsedText, sortDevices, type PairedDevicesSnapshot } from '../sections/paired-devices-model.js';
import type { pendingPhonesQuery } from '../sections/pending-phones-query.js';

type PendingSnapshot = Awaited<ReturnType<typeof pendingPhonesQuery.fetch>>;
type HubTile = { title: string; reading: string; detail: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' };

export function phoneTile(devices: PairedDevicesSnapshot | { kind: 'notInBuild' } | null, pending: PendingSnapshot | null, nowMs: number): HubTile | null {
  if (!devices || 'kind' in devices || !pending) return null;
  if ('kind' in pending) return { title: 'Phone', reading: 'Phone status unavailable', detail: 'Phone approval status is unavailable.', tone: 'warn' };
  const active = sortDevices(devices.devices.filter(device => device.revokedAt === null));
  const count = pending.approvals.length;
  if (count) return { title: 'Phone: approve', reading: `${count} waiting for approval`,
    detail: `${count} ${count === 1 ? 'phone is' : 'phones are'} waiting for your approval. Approve or deny ${count === 1 ? 'it' : 'them'} in Settings › Connection.`, tone: 'danger' };
  if (!active.length) return { title: 'Phone', reading: 'Not paired', detail: 'No phone is paired.', tone: 'neutral' };
  const last = active[0]!.lastUsedAt;
  const age = last === null ? NaN : nowMs - Date.parse(last);
  const used = last === null ? 'never' : Number.isFinite(age) && age >= 0 ? lastUsedText(last, nowMs).replace(/^last used /, '') : 'unknown';
  const full = `${active.length} paired · last read ${used}`;
  return { title: 'Phone', reading: full.length < 48 ? full : `${full.slice(0, 46)}…`,
    detail: `${active.length} ${active.length === 1 ? 'phone is' : 'phones are'} paired. Last read ${used}.`,
    tone: Number.isFinite(age) && age >= 0 && age < 3_600_000 ? 'ok' : age > 86_400_000 ? 'warn' : 'neutral' };
}
