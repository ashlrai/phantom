const etFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function etWallMs(ms: number): number {
  const parts = etFormatter.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}

export function parseInboxAt(at: string, nowMs: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (year! < 100 || month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59) return null;
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const date = new Date(wall);
  if (date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  // Sampling both sides of a transition handles DST gaps and repeated hours.
  const candidates = [-86_400_000, 86_400_000].map(delta => {
    const sample = wall + delta;
    return wall - (etWallMs(sample) - sample);
  }).filter(candidate => etWallMs(candidate) === wall).sort((a, b) => a - b);
  if (!candidates.length) return null;
  return candidates.filter(candidate => candidate <= nowMs).at(-1) ?? candidates[0]!;
}

export function newestLeaderPassMs(leaders: ReadonlyArray<{ ageSeconds: number | null }> | undefined, generatedAtMs: number): number | null {
  if (!Number.isFinite(generatedAtMs)) return null;
  const ages = (leaders ?? []).map(leader => leader.ageSeconds)
    .filter((age): age is number => age !== null && Number.isFinite(age) && age >= 0);
  return ages.length ? generatedAtMs - Math.min(...ages) * 1_000 : null;
}

export function ackState(entryMs: number | null, newestPassMs: number | null): 'seen' | 'waiting' | 'unknown' {
  if (entryMs === null || newestPassMs === null) return 'unknown';
  return newestPassMs > entryMs ? 'seen' : 'waiting';
}

export function ackText(state: ReturnType<typeof ackState>, _waitingSinceMs?: number): string {
  return state === 'seen' ? 'Seen by a leader pass' : state === 'waiting'
    ? 'Waiting for the next leader pass (every 15 min)' : 'Leader status unknown';
}

export const DESKTOP_SOURCE_LABELS: readonly string[] = ['Phantom desktop', 'Chat'];

export function sourceChip(source: string): string {
  const trimmed = source.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.includes('telegram')) return 'Telegram';
  if (normalized.includes('mail')) return 'Email';
  switch (normalized) {
    case 'phantom desktop': case 'desktop': return 'Phantom desktop';
    case 'phantom desktop chat': case 'chat': return 'Chat';
    case 'mobile': case 'phantom mobile': case 'mobile remote': return 'Mobile remote';
    case 'fleet-say': return 'fleet-say';
    case 'mcp': return 'MCP';
    case 'api': return 'API';
    case 'phone': return 'Phone';
    case 'terminal': case 'cli': return 'Terminal';
    case 'page': return 'Page';
    default: return trimmed.slice(0, 24);
  }
}

export const DRAFT_KEY = 'phantom.interject.draft';
export function loadDraft(storage: Pick<Storage, 'getItem'>): string {
  try { return storage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
}
export function saveDraft(storage: Pick<Storage, 'setItem' | 'removeItem'>, text: string): void {
  try { if (text) storage.setItem(DRAFT_KEY, text); else storage.removeItem(DRAFT_KEY); } catch { /* Storage can be unavailable. */ }
}
