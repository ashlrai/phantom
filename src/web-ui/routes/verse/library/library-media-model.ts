export interface MediaItem { name: string; bytes: number; type: string; modifiedAt: string }
export interface MediaList { state: 'ok' | 'absent' | 'unavailable'; items: MediaItem[] }

export function narrowMedia(value: unknown): MediaList | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!['ok', 'absent', 'unavailable'].includes(String(data.state)) || !Array.isArray(data.items)) return null;
  if (data.state !== 'ok' && data.items.length) return null;
  if (!data.items.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.name === 'string' && /^[0-9a-f]{16}\.(png|jpg|webp)$/.test(row.name)
      && Number.isSafeInteger(row.bytes) && (row.bytes as number) >= 0
      && typeof row.type === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(row.type)
      && typeof row.modifiedAt === 'string' && Number.isFinite(Date.parse(row.modifiedAt));
  })) return null;
  return data as unknown as MediaList;
}
