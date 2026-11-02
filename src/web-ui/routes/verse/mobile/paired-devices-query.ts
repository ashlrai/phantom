import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { sinceText } from './connectivity.js';

interface PairedDevice {
  id: string;
  label: string;
  email: string;
  act: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface PairedDevicesV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing';
  devices: PairedDevice[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Require a complete ISO timestamp, including a timezone, and reject rolled-over dates.
function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, month, day, hour, minute, second, zone] = m;
  const year = Number(y), mo = Number(month), d = Number(day);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1]!
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59))
    && Number.isFinite(Date.parse(value));
}

const nullableDate = (value: unknown): value is string | null => value === null || isoDate(value);

export function narrowPairedDevices(raw: unknown): PairedDevicesV1 | null {
  if (!record(raw) || raw.v !== 1 || !isoDate(raw.generatedAt)
    || (raw.sourceState !== 'healthy' && raw.sourceState !== 'missing') || !Array.isArray(raw.devices)) return null;
  const devices: PairedDevice[] = [];
  for (const device of raw.devices) {
    if (!record(device) || typeof device.id !== 'string' || typeof device.label !== 'string'
      || typeof device.email !== 'string' || typeof device.subject !== 'string' || typeof device.act !== 'boolean'
      || !isoDate(device.createdAt) || !nullableDate(device.lastUsedAt) || !nullableDate(device.revokedAt)) return null;
    // Do not retain the subject or any unknown fields in the query cache.
    devices.push({ id: device.id, label: device.label, email: device.email, act: device.act,
      createdAt: device.createdAt, lastUsedAt: device.lastUsedAt, revokedAt: device.revokedAt });
  }
  return { v: 1, generatedAt: raw.generatedAt, sourceState: raw.sourceState, devices };
}

const PATH = '/api/verse/fleet/control/remote-devices';
export const pairedDevicesQuery: QueryDef<PairedDevicesV1 | null> = {
  key: 'verse-mobile-paired-devices',
  fetch: async (signal) => {
    try {
      const data = narrowPairedDevices(await apiGet<unknown>(PATH, signal));
      if (!data) throw new ApiError('Unrecognized paired devices response.', 502, PATH);
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

function maskedEmail(email: string): string | null {
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  return match ? `…${Array.from(match[1]!).at(-1)}@${match[2]}` : null;
}

export function deviceRows(data: PairedDevicesV1, nowMs: number, currentLabel: string | null) {
  return [...data.devices].sort((a, b) =>
    Number(a.revokedAt !== null) - Number(b.revokedAt !== null)
    || (b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity) - (a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity),
  ).map((device) => {
    const used = device.lastUsedAt
      ? `last used ${sinceText(Date.parse(device.lastUsedAt), nowMs).replace(/^Updated /, '').replace(' min ago', ' m ago')}`
      : 'never used';
    const revoked = device.revokedAt ? ` · Revoked ${new Date(device.revokedAt).toLocaleDateString()}` : '';
    return { id: device.id, label: device.label, email: maskedEmail(device.email),
      text: `${device.act ? 'Act' : 'Read only'} · ${used}${revoked}`,
      current: currentLabel !== null && device.label === currentLabel };
  });
}
