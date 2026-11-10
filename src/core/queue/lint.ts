import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface QueueLintFinding { line: number; id: string | null; reason: string }
const lanes = new Set(['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local']);
const tiers = new Set(['frontier', 'work', 'mid', 'fast']);

/** First required READY-line field absent from the parenthesized metadata, in contract order. */
function missingReadyField(text: string, id: string | undefined): string | null {
  if (!id) return 'id';
  const metadata = /^- READY [^\s(]*\s*\(([^)]*)\)(.*)$/.exec(text);
  const fields = metadata?.[1]?.split(',').map(field => field.trim()) ?? [];
  if (!fields.some(field => /^P\d+(?:\s+[^=]*)?$/.test(field))) return 'priority';
  if (!fields.some(field => /^pool=\S+$/.test(field))) return 'pool';
  if (!fields.some(field => /^tier=\S+$/.test(field))) return 'tier';
  if (!fields.some(field => /^repo=\S+$/.test(field))) return 'repo';
  if (!/^\s*:\s*\S/.test(metadata?.[2] ?? '')) return 'goal';
  return null;
}

/** Inspect the two persisted queue files; missing age evidence remains unknown. */
export async function lintQueue(router: string, ready: string, runsDir: string, home: string, now: number) {
  const duplicates: QueueLintFinding[] = [], old: QueueLintFinding[] = [], unknownAge: QueueLintFinding[] = [], invalid: QueueLintFinding[] = [], missingFields: QueueLintFinding[] = [];
  const prior = new Map<string, { status: string; line: number }>();
  for (const [index, text] of router.split(/\r?\n/).entries()) {
    const row = /^- (READY|CLAIMED|DONE)\b\s+(.*)$/.exec(text);
    if (!row) continue;
    const id = row[1] === 'READY' ? /^([A-Za-z0-9][A-Za-z0-9._-]+)\b/.exec(row[2]!)?.[1]
      : /\b((?:RQ|RADAR|LAND|G\d|FIX)[A-Za-z0-9._-]*[A-Za-z0-9])\b/.exec(row[2]!)?.[1];
    const line = index + 1;
    if (row[1] === 'READY') {
      const missing = missingReadyField(text, id);
      if (missing) missingFields.push({ line, id: id ?? null, reason: `Missing ${missing}` });
      if (!id) continue;
      const earlier = prior.get(id);
      if (earlier) duplicates.push({ line, id, reason: `Already ${earlier.status} on line ${earlier.line}` });
      const timestamps = [...text.matchAll(/\b(?:queued|queued_at|created|created_at)=([^,\s)]+)/gi)].map(m => m[1]!);
      const time = timestamps.length === 1 && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(timestamps[0]!) ? Date.parse(timestamps[0]!) : NaN;
      if (!Number.isFinite(time) || time > now) unknownAge.push({ line, id, reason: 'Queue time is unknown' });
      else if (now - time > 2 * 60 * 60 * 1000) old.push({ line, id, reason: 'READY for more than 2 hours' });
    } else if (id && !prior.has(id)) prior.set(id, { status: row[1]!, line });
  }
  const promptRoot = await realpath(join(runsDir, 'queue/prompts')).catch(() => null);
  for (const [index, text] of ready.split(/\r?\n/).entries()) {
    if (!text.trim() || text.startsWith('#')) continue;
    const f = text.split('\t');
    if (f[0]!.startsWith('PARKED-') || f[2]?.startsWith('PARKED-')) continue;
    const reasons: string[] = [];
    if (f.length < 5) reasons.push('Fewer than 5 tab-separated fields');
    if (!/^[A-Za-z0-9._-]+$/.test(f[0] ?? '')) reasons.push('Invalid job id');
    if (!lanes.has(f[2] ?? '')) reasons.push('Unknown lane');
    if (!tiers.has(f[3] ?? '')) reasons.push('Unknown tier');
    if (!f[1] || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f[1]) || !(await stat(join(home, 'Projects/ashlrai', f[1])).then(s => s.isDirectory()).catch(() => false))) reasons.push('Repository directory not found or invalid');
    const prompt = f[4] ?? '';
    const resolved = await realpath(prompt).catch(() => null);
    if (!resolved || !promptRoot || !resolved.startsWith(`${promptRoot}/`) || !(await stat(prompt).then(s => s.isFile()).catch(() => false))) reasons.push('Prompt file not found in queue/prompts');
    if (reasons.length) invalid.push({ line: index + 1, id: /^[A-Za-z0-9._-]{1,128}$/.test(f[0] ?? '') ? f[0]! : null, reason: reasons.join('; ') });
  }
  return { schema: 'queue.lint.v1', duplicates, invalid, old, unknownAge, missingFields };
}
