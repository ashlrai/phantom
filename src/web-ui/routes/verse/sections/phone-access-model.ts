export interface PhoneAccess {
  v: 1;
  generatedAt: string;
  gateway: 'running' | 'not-running';
  phoneUrl: string | null;
  publicOrigin: string | null;
  pending: number;
  devices: { active: number; revoked: number };
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readPhoneAccess(data: unknown): PhoneAccess | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.v !== 1 || typeof value.generatedAt !== 'string' || !value.generatedAt
    || (value.gateway !== 'running' && value.gateway !== 'not-running')
    || !count(value.pending) || !value.devices || typeof value.devices !== 'object') return null;
  const devices = value.devices as Record<string, unknown>;
  if (!count(devices.active) || !count(devices.revoked)) return null;
  if (value.publicOrigin !== null && typeof value.publicOrigin !== 'string') return null;
  if (value.phoneUrl !== null && typeof value.phoneUrl !== 'string') return null;
  try {
    const origin = value.publicOrigin === null ? null : new URL(value.publicOrigin as string);
    const phone = value.phoneUrl === null ? null : new URL(value.phoneUrl as string);
    if (origin && (origin.protocol !== 'https:' || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash)) return null;
    if (phone && (!origin || phone.protocol !== 'https:' || phone.origin !== origin.origin
      || phone.username || phone.password || !phone.pathname.endsWith('/verse/m')
      || phone.search || phone.hash)) return null;
  } catch { return null; }
  return {
    v: 1, generatedAt: value.generatedAt, gateway: value.gateway,
    phoneUrl: value.phoneUrl as string | null, publicOrigin: value.publicOrigin as string | null,
    pending: value.pending, devices: { active: devices.active, revoked: devices.revoked },
  };
}

export function phoneAccessTell(a: PhoneAccess): string {
  if (!a.publicOrigin) return 'No phone gateway configured yet';
  if (a.gateway === 'not-running') return 'Gateway not running · start the Mac with --remote-config';
  const phones = `${a.devices.active} phone${a.devices.active === 1 ? '' : 's'} paired`;
  const pending = `${a.pending} pairing${a.pending === 1 ? ' waits' : 's wait'} for you`;
  return `Gateway running · ${phones} · ${pending}`;
}

export function inviteCommand(): string {
  return 'ashlr verse remote invite <Access-subject> act';
}

// encodeQr (components/qr/qr-encode.ts) stops at version 10 / level M: 213 UTF-8 bytes.
const QR_BYTE_LIMIT = 213;

export function phoneUrlFitsQr(url: string): boolean {
  return new TextEncoder().encode(url).length <= QR_BYTE_LIMIT;
}
