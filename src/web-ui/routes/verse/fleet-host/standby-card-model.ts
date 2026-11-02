export type FleetStandbyView = { v: 1; generatedAt: string } & (
  { configured: false } | { configured: true; available: false } |
  { configured: true; available: true; ready: boolean; blocker: string | null; leaseHolder: string | null; snapshotAgeSec: number | null });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function narrowFleetStandby(raw: unknown): FleetStandbyView | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string' || typeof raw.configured !== 'boolean') return null;
  if (raw.configured) {
    if (typeof raw.available !== 'boolean') return null;
    if (raw.available && (typeof raw.ready !== 'boolean' ||
      !(raw.blocker === null || typeof raw.blocker === 'string') || !(raw.leaseHolder === null || typeof raw.leaseHolder === 'string') ||
      !(raw.snapshotAgeSec === null || (typeof raw.snapshotAgeSec === 'number' && Number.isFinite(raw.snapshotAgeSec) && raw.snapshotAgeSec >= 0)))) return null;
  }
  return raw as FleetStandbyView;
}
function seconds(n: number): string {
  if (n < 90) return `${Math.round(n)} sec`;
  if (n < 5400) return `${Math.round(n / 60)}m`;
  return n < 172800 ? `${Math.round(n / 3600)} h` : `${Math.round(n / 86400)} days`;
}
export function standbySentence(view: FleetStandbyView): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!view.configured) return { text: 'Second computer: not set up. Run ashlr fleet standby --help.', tone: 'muted' };
  if (!view.available) return { text: 'Second computer: no reading.', tone: 'muted' };
  if (!view.ready) return { text: `Second computer cannot take over: ${view.blocker ?? 'unknown'}.`, tone: 'warn' };
  return { text: view.snapshotAgeSec === null ? 'Second computer can take over. Snapshot age is unknown.'
    : `Second computer can take over. Up to ${seconds(view.snapshotAgeSec)} of work would be lost.`, tone: 'ok' };
}
