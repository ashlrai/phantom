export interface PalettePhone {
  phoneUrl: string | null;
  gateway: 'running' | 'not-running';
  active: number;
  pending: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function secureUrl(value: unknown, path: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === path && !url.search && !url.hash && value === url.href;
  } catch { return false; }
}

export function palettePhone(data: unknown): PalettePhone | null {
  if (!record(data) || data.v !== 1 || typeof data.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(data.generatedAt))
    || (data.gateway !== 'running' && data.gateway !== 'not-running')
    || (data.phoneUrl !== null && !secureUrl(data.phoneUrl, '/verse/m'))
    || (data.publicOrigin !== null && !(typeof data.publicOrigin === 'string'
      && secureUrl(`${data.publicOrigin}/`, '/') && new URL(data.publicOrigin).origin === data.publicOrigin))
    || (typeof data.phoneUrl === 'string' && (typeof data.publicOrigin !== 'string'
      || new URL(data.phoneUrl).origin !== data.publicOrigin))
    || !count(data.pending) || !record(data.devices)
    || !count(data.devices.active) || !count(data.devices.revoked)) return null;
  return { phoneUrl: data.phoneUrl, gateway: data.gateway, active: data.devices.active, pending: data.pending };
}

export function phoneItemTitle(_phone: PalettePhone): string {
  return 'Copy phone URL';
}

export function phoneItemSubtitle(phone: PalettePhone): string {
  if (phone.gateway === 'not-running') return 'gateway not running';
  const paired = `${phone.active} phone${phone.active === 1 ? '' : 's'} paired`;
  return `gateway running · ${paired}${phone.pending > 0 ? ` · ${phone.pending} waiting for you` : ''}`;
}
