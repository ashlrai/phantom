/** Read-only projection of a planner pass from the ingest ledger and drop folders. */
import { lstat, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DROP_JOB_ID } from './drop-job-writer.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';

type State = 'ok' | 'missing' | 'invalid';
type DropSource = { dir: string; state: State };
export interface PlannerPassOutput {
  v: 1;
  window: { since: string; until: string };
  ingested: Array<{ id: string; who: 'claude' | 'sol'; lane: string; tier: string; at: string }>;
  pending: Array<{ id: string; dropDir: string; ageSeconds: number }>;
  rejected: Array<{ id: string; reason: string; at: string }>;
  counts: { ingested: number; pending: number; rejected: number };
  sources: { ledger: State; drops: DropSource[]; skipped: number };
}

// Bound both IO and work, including an unusually large or malformed ledger.
const LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const FIELD = /^[A-Za-z0-9_-]{1,80}$/;
const REASON = /^[A-Za-z0-9_-]{1,80}$/;
const fullId = (value: string): boolean => value.startsWith('RQ-PHX-') && DROP_JOB_ID.test(value.slice(7));

export async function readPlannerPassOutput(opts: {
  runsRoot: string; home?: string; sinceMs: number; untilMs?: number; now?: () => number;
}): Promise<PlannerPassOutput> {
  let nowMs: number;
  try { nowMs = (opts.now ?? Date.now)(); } catch { nowMs = Date.now(); }
  if (!Number.isFinite(nowMs)) nowMs = Date.now();
  const since = Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
  const until = Number.isFinite(opts.untilMs) ? opts.untilMs! : nowMs;
  const safeIso = (ms: number): string => {
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
  };
  const view: PlannerPassOutput = {
    v: 1, window: { since: safeIso(since), until: safeIso(until) },
    ingested: [], pending: [], rejected: [], counts: { ingested: 0, pending: 0, rejected: 0 },
    sources: { ledger: 'invalid', drops: [], skipped: 0 },
  };
  try {
    const root = opts.runsRoot;
    const dirs = [join(root, 'leader', 'drop', 'claude'), join(opts.home ?? homedir(), 'Projects', 'ashlrai', '.orch-drop', 'sol'), join(root, 'leader', 'drop', 'done')];
    const ledgerPath = join(root, 'leader', 'drop', 'ingested.tsv');
    const source = await readSource(ledgerPath, LEDGER_BYTES, true);
    view.sources.ledger = source.state === 'healthy' ? 'ok' : source.state === 'missing' ? 'missing' : 'invalid';
    // A byte-limited tail can contain fewer than 2000 rows; flag uncertain coverage.
    if (source.state === 'healthy') {
      try { if ((await lstat(ledgerPath)).size > LEDGER_BYTES) view.sources.ledger = 'invalid'; }
      catch { view.sources.ledger = 'invalid'; }
    }
    const rows = source.text.split('\n');
    if (rows.at(-1) === '') rows.pop();
    for (const raw of rows.slice(-2000)) {
      const cells = raw.replace(/\r$/, '').split('\t');
      const [timestamp, id, who, lane, tier] = cells;
      const time = localTimestamp(timestamp ?? '');
      if (cells.length !== 6 || !id || !fullId(id) || (who !== 'claude' && who !== 'sol') || !lane || !FIELD.test(lane) || !tier || !FIELD.test(tier) || !Number.isFinite(time.ms)) {
        view.sources.skipped++;
        view.sources.ledger = 'invalid';
        continue;
      }
      if (time.ms >= since && time.ms <= until) view.ingested.push({ id, who, lane, tier, at: time.at });
    }
    for (const [index, dir] of dirs.entries()) {
      const drop: DropSource = { dir, state: 'ok' };
      view.sources.drops.push(drop);
      try {
        const info = await lstat(dir);
        if (!info.isDirectory()) throw new Error('invalid directory');
        const entries = await opendir(dir);
        let seen = 0;
        for await (const entry of entries) {
          if (++seen > MAX_ENTRIES) { drop.state = 'invalid'; break; }
          const match = index === 2 ? /^(.+)\.md\.(.+)$/.exec(entry.name) : /^(.+)\.md$/.exec(entry.name);
          if (!match) continue;
          const id = match[1]!;
          const reason = match[2];
          if (!fullId(id) || (index === 2 && (!reason || !REASON.test(reason)))) { view.sources.skipped++; continue; }
          try {
            const stat = await lstat(join(dir, entry.name));
            if (!stat.isFile()) { view.sources.skipped++; continue; }
            if (stat.mtimeMs < since || stat.mtimeMs > until) continue;
            if (index === 2) view.rejected.push({ id, reason: reason!, at: stat.mtime.toISOString() });
            else view.pending.push({ id, dropDir: dir, ageSeconds: Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1000)) });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') drop.state = 'invalid';
          }
        }
      } catch (error) { drop.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'; }
    }
  } catch {
    // Invalid input or an unexpected IO failure is represented in source states.
  }
  view.ingested.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  view.pending.sort((a, b) => a.id.localeCompare(b.id) || a.dropDir.localeCompare(b.dropDir));
  view.rejected.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  view.counts = { ingested: view.ingested.length, pending: view.pending.length, rejected: view.rejected.length };
  return view;
}

export function summarizePlannerPassOutput(view: PlannerPassOutput): string {
  const { ingested, pending, rejected } = view.counts;
  const total = ingested + pending + rejected;
  return total === 0 ? 'Pass wrote no jobs' : `Pass wrote ${total} jobs: ${ingested} ingested, ${pending} pending, ${rejected} rejected`;
}
