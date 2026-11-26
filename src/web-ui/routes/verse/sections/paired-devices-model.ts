import { ageInSeconds, relativeTime } from '../../../lib/relative-time.js';
export interface PairedDevice {
  id: string;
  label: string;
  email: string;
  subject: string;
  act: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface PairedDevicesSnapshot {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing';
  devices: PairedDevice[];
}

export function sortDevices(devices: readonly PairedDevice[]): PairedDevice[] {
  return [...devices].sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null)
    || (b.lastUsedAt === null ? 0 : Date.parse(b.lastUsedAt)) - (a.lastUsedAt === null ? 0 : Date.parse(a.lastUsedAt)));
}

export function lastUsedText(at: string | null, now: number): string {
  if (at === null) return 'never';
  const reading = relativeTime(at, now);
  return reading ? `last used ${ageInSeconds(reading.seconds, 'spaced').replace(/min/g, 'm')}` : 'last used at an unknown time';
}

export function revokeCommand(id: string): string | null {
  return /^[0-9a-f-]{36}$/.test(id) ? `phm console remote revoke ${id}` : null;
}
