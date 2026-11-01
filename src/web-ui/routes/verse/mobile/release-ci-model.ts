import { dailyCiLine } from '../fleet-releases/daily-ci-line.js';
import type { CiRunFactsV1 } from '../fleet-releases/fleet-releases-queries.js';

export function releaseCiRow(facts: CiRunFactsV1 | undefined, nowMs: number): { title: string; tone: 'ok' | 'bad' | 'muted'; href: string | null } | null {
  const line = dailyCiLine(facts, nowMs);
  if (line.tone === 'none') return null;
  let href: string | null = null;
  try {
    const url = new URL(line.url ?? '');
    if (url.protocol === 'https:' && url.hostname === 'github.com') href = url.href;
  } catch { /* No safe run link. */ }
  return {
    title: line.text + (line.detail ? ` · ${line.detail}` : ''),
    tone: line.tone === 'stale' ? 'muted' : line.tone,
    href,
  };
}
