export function parseClaudeLane(value: string | null | undefined, nowMs: number): {
  down: boolean; reason: string | null; since: string | null; sinceText: string | null; text: string | null;
} {
  const text = value?.trim() ? value : null;
  const down = /^down/i.test(text ?? '');
  if (!down || !text) return { down, reason: null, since: null, sinceText: null, text };

  const timestamp = text.match(/(?:^|\s)(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)(?=\s|$)/i);
  const trailingTimestamp = timestamp && !text.slice((timestamp.index ?? 0) + timestamp[0].length).trim();
  const date = timestamp ? new Date(timestamp[1].replace(' ', 'T')) : null;
  const validDate = date !== null && Number.isFinite(date.getTime());
  const reason = (trailingTimestamp ? text.slice(4, timestamp.index) : text.slice(4)).trim().replace(/^:\s*/, '').replace(/\s*:\s*$/, '').trim() || null;
  const since = validDate ? date.toISOString() : null;
  let sinceText: string | null = null;
  if (validDate) {
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const elapsed = Math.floor((nowMs - date.getTime()) / 60_000);
    const age = !Number.isFinite(elapsed) || elapsed < 0 ? null : elapsed < 60 ? `${elapsed} min ago` : elapsed < 1440 ? `${Math.floor(elapsed / 60)} h ago` : `${Math.floor(elapsed / 1440)} d ago`;
    sinceText = `since ${time}${age ? `, ${age}` : ''}`;
  }
  return { down, reason, since, sinceText, text };
}

export function claudeLaneFix(): string {
  return 'Run on this Mac: ~/.ashlr-runs/bin/fix-claude-lane.sh';
}
