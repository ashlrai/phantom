import { ago } from '../command/ladder-model.js';
import { parseInboxAt } from '../fleet/interject-ack-model.js';
import { inboxSeen } from './inbox-seen-model.js';

/** Adapt the optional inbox tail in the Home snapshot without guessing missing data. */
export function homeLastOrder(runs: unknown, nowMs: number):
  { title: string; subtitle: string; ackLabel: string; tone: 'success' | 'neutral' | 'warning' } | null {
  if (typeof runs !== 'object' || runs === null || !('inbox' in runs) || !Array.isArray(runs.inbox)) return null;
  const entry: unknown = runs.inbox.at(-1);
  if (typeof entry !== 'object' || entry === null || !('at' in entry) || typeof entry.at !== 'string'
    || !('source' in entry) || typeof entry.source !== 'string' || !('text' in entry) || typeof entry.text !== 'string') return null;
  const snapshot = 'generatedAt' in runs && typeof runs.generatedAt === 'string' && 'leaders' in runs && Array.isArray(runs.leaders)
    ? { generatedAt: runs.generatedAt, leaders: runs.leaders.flatMap((leader: unknown) => {
      if (typeof leader !== 'object' || leader === null || !('ageSeconds' in leader)) return [];
      return typeof leader.ageSeconds === 'number' || leader.ageSeconds === null ? [{ ageSeconds: leader.ageSeconds }] : [];
    }) } : undefined;
  const seen = inboxSeen([{ at: entry.at, source: entry.source, text: entry.text, priority: null }], snapshot, nowMs).entries[0]!;
  const at = parseInboxAt(entry.at, nowMs);
  const excerpt = entry.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    title: 'Your last order',
    subtitle: `${entry.source} · ${ago(at === null ? entry.at : new Date(at).toISOString(), nowMs)}: ${excerpt}`,
    ackLabel: seen.ackLabel,
    tone: seen.tone === 'ok' ? 'success' : seen.tone,
  };
}
