/** Read-only view of queue/landed-closes.jsonl (written by `ashlr fleet landed-close`) for the Verse Live home. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../util/public-json.js';

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 20;
const REASON_MAX = 160;
const DAY_MS = 24 * 3_600_000;
const OUTCOMES = new Set(['closed', 'skipped', 'failed']);

export type LandedCloseOutcome = 'closed' | 'skipped' | 'failed';
export interface LandedCloseRow { at: string; pr: number; outcome: LandedCloseOutcome; reason?: string }
export interface LandedClosesReport {
  v: 1;
  known: boolean;
  closed: number;
  skipped: number;
  failed: number;
  rows: LandedCloseRow[] | null;
}

/** Same resolution the sibling fleet APIs use: ASHLR_RUNS_DIR, else ~/.ashlr-runs. */
export function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

/** Reads the last 256 KiB; a missing file is known with zero counts, any other failure is unknown. Never throws. */
export async function readLandedCloses(runsDir: string = defaultRunsDir(), now: number = Date.now(), windowMs: number = DAY_MS): Promise<LandedClosesReport> {
  const empty = { v: 1, closed: 0, skipped: 0, failed: 0 } as const;
  let text: string;
  try {
    const handle = await open(join(runsDir, 'queue', 'landed-closes.jsonl'), 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - MAX_BYTES);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      text = buf.toString('utf8', 0, bytesRead);
      // A tail read can begin mid-line; that fragment is never a valid row.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...empty, known: true, rows: [] };
    return { ...empty, known: false, rows: null };
  }
  const kept: { ms: number; row: LandedCloseRow }[] = [];
  for (const line of text.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const r = parsed as Record<string, unknown>;
    if (typeof r.pr !== 'number' || !Number.isInteger(r.pr) || r.pr <= 0) continue;
    if (typeof r.outcome !== 'string' || !OUTCOMES.has(r.outcome)) continue;
    const ms = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(ms) || ms > now || ms < now - windowMs) continue;
    const row: LandedCloseRow = { at: new Date(ms).toISOString(), pr: r.pr, outcome: r.outcome as LandedCloseOutcome };
    if (typeof r.reason === 'string' && r.reason.trim()) {
      row.reason = sanitizePublicJson(r.reason.trim().slice(0, REASON_MAX)) as string;
    }
    kept.push({ ms, row });
  }
  kept.sort((a, b) => b.ms - a.ms);
  const count = (o: LandedCloseOutcome) => kept.filter(k => k.row.outcome === o).length;
  return { v: 1, known: true, closed: count('closed'), skipped: count('skipped'), failed: count('failed'),
    rows: kept.slice(0, MAX_ROWS).map(k => k.row) };
}
