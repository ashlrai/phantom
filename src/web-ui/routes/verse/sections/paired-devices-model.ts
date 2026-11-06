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
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 60) return `last used ${minutes} m ago`;
  if (minutes < 1440) return `last used ${Math.floor(minutes / 60)} h ago`;
  return `last used ${Math.floor(minutes / 1440)} d ago`;
}

export function revokeCommand(id: string): string | null {
  return /^[0-9a-f-]{36}$/.test(id) ? `phm verse remote revoke ${id}` : null;
}
