export interface PendingPhone {
  id: string;
  label: string;
  email: string;
  deviceType?: string;
}

export type PendingGateway = 'running' | 'not-running';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);

export function readPendingPhones(data: unknown): PendingPhone[] | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value['v'] !== 1 || typeof value['generatedAt'] !== 'string' ||
    (value['gateway'] !== 'running' && value['gateway'] !== 'not-running') || !Array.isArray(value['approvals'])) return null;
  const phones: PendingPhone[] = [];
  for (const item of value['approvals'] as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!validId(row['id']) || typeof row['label'] !== 'string' || typeof row['email'] !== 'string' ||
      typeof row['subject'] !== 'string' || (row['deviceType'] !== undefined && typeof row['deviceType'] !== 'string')) return null;
    phones.push({ id: row['id'], label: row['label'].slice(0, 200), email: row['email'].slice(0, 200),
      ...(typeof row['deviceType'] === 'string' ? { deviceType: row['deviceType'].slice(0, 200) } : {}) });
  }
  return phones;
}

export function pendingTell(n: number, gateway: PendingGateway): string {
  if (gateway === 'not-running') return 'Phone gateway is not running.';
  return `${n} phone${n === 1 ? '' : 's'} awaiting approval.`;
}

export function approveOutcomeText(result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as Record<string, unknown>;
    if (typeof value['error'] === 'string' && value['error']) return value['error'].slice(0, 200);
    if (value['approved'] === true && validId(value['deviceId'])) return `Approved · device ${value['deviceId']}`;
    if (value['denied'] === true) return 'Denied';
  }
  return 'Pairing outcome could not be confirmed.';
}
