import { isAbsolute } from 'node:path';
import { readResetReleases } from '../core/fleet/usage-reset-release.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet reset-history [--runs-dir ABS] [--limit N] [--lane NAME] [--json]';
interface Dependencies {
  read?: typeof readResetReleases;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetResetHistory(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage}`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  let runsDir: string | undefined, lane: string | undefined, limit: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--runs-dir' && runsDir === undefined && next && isAbsolute(next) && !next.includes('\0')) { runsDir = next; i++; continue; }
    if (arg === '--lane' && lane === undefined && next && !next.startsWith('-') && !next.includes('\0')) { lane = next; i++; continue; }
    if (arg === '--limit' && limit === undefined && next && /^[1-9]\d*$/.test(next) && Number(next) <= 200) { limit = Number(next); i++; continue; }
    return invalid();
  }
  const count = limit ?? 20;
  let rows: Awaited<ReturnType<typeof readResetReleases>>;
  try { rows = await (deps.read ?? readResetReleases)(runsDir, lane === undefined ? count : 200); }
  catch { error('fleet reset-history: unable to read recorded releases'); return 1; }
  // Audit strings are untrusted. Omit reasons and redact absolute paths even if
  // they were placed in a field normally expected to contain a lane or time.
  const clean = (value: string | null): string | null => value?.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]') ?? null;
  const records = rows.filter(row => lane === undefined || row.lane === lane).slice(0, count).map(row => ({
    lane: clean(row.lane), at: clean(row.at), state: row.state, usedPct: row.usedPct,
    readingAsOf: clean(row.readingAsOf), heldUntil: clean(row.heldUntil),
  }));
  const payload = sanitizePublicJson({ v: 1, records }) as { v: number; records: typeof records };
  if (json) output(JSON.stringify(payload));
  else {
    const safe = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const lines = ['Recorded releases (not a live lane-health verdict):'];
    for (const row of payload.records) lines.push(`  lane ${safe(row.lane)} · released ${safe(row.at)} · ${safe(row.state)} · usedPct ${safe(row.usedPct)} · readingAsOf ${safe(row.readingAsOf)} · heldUntil ${safe(row.heldUntil)}`);
    if (!payload.records.length) lines.push('  No recorded releases.');
    output(lines.join('\n'));
  }
  return 0;
}
