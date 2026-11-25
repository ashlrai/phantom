/** `phm queue visits-sync [--apply] [--json]`: fold jobs.jsonl + merge-events.jsonl + router-queue.md into the visit journal. Dry run unless --apply. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compactQueueVisits, queueJournalPath, readQueueVisits, recordQueueVisit } from '../core/queue/journal.js';
import { isQueueVisit, queueVisitKey } from '../core/queue/stats.js';
import {
  foldMergeEventChecks, planVisitSync, queueReadyVisits, queueVisitsFromJobs, VISIT_SYNC_SCHEMA,
} from '../core/queue/visit-sync.js';

export const QUEUE_VISITS_SYNC_USAGE = `Usage: phm queue visits-sync [--jobs <path>] [--merge-events <path>] [--queue <path>] [--journal <path>] [--apply] [--json]
Folds the jobs ledger (default <runs>/metrics/jobs.jsonl), the merge-events
check observations (default <runs>/metrics/merge-events.jsonl) that derive the
pr-ci service start and merge-queue entry boundary, and the live router
queue (default <runs>/queue/router-queue.md) into station visits and appends new
or progressed snapshots to the visit journal (default ~/.ashlr/queue/visits.jsonl)
that \`phm queue stats\` and GET /api/queue/stats read. Dry run unless --apply.
Station mapping and honesty rules: docs/QUEUE-STATS.md.
Exit 0 ok, 1 unreadable ledger or journal, 2 bad usage.`;

function runsDir(): string {
  const env = process.env.ASHLR_RUNS_DIR;
  return env && env.startsWith('/') ? env : join(homedir(), '.ashlr-runs');
}

interface Args { jobs?: string; mergeEvents?: string; queue?: string; journal?: string; apply: boolean; json: boolean }

function parseArgs(args: string[]): Args | null {
  const out: Args = { apply: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--jobs' || arg === '--merge-events' || arg === '--queue' || arg === '--journal') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return null;
      out[arg === '--merge-events' ? 'mergeEvents' : arg.slice(2) as 'jobs' | 'queue' | 'journal'] = value;
    } else return null;
  }
  return out;
}

export async function cmdQueueVisitsSync(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(QUEUE_VISITS_SYNC_USAGE); return 0; }
  const parsed = parseArgs(args);
  if (!parsed) { console.error(QUEUE_VISITS_SYNC_USAGE); return 2; }
  const jobsPath = parsed.jobs ?? join(runsDir(), 'metrics', 'jobs.jsonl');
  const mergeEventsPath = parsed.mergeEvents ?? join(runsDir(), 'metrics', 'merge-events.jsonl');
  const queuePath = parsed.queue ?? join(runsDir(), 'queue', 'router-queue.md');
  const journalPath = parsed.journal ?? queueJournalPath();
  const now = Date.now();
  try {
    const jobsText = await readFile(jobsPath, 'utf8');
    let mergeEventsText: string | null = null;
    try { mergeEventsText = await readFile(mergeEventsPath, 'utf8'); } catch { mergeEventsText = null; }
    const fold = queueVisitsFromJobs(jobsText, now, foldMergeEventChecks(mergeEventsText));
    let queueText: string | null = null;
    try { queueText = await readFile(queuePath, 'utf8'); } catch { queueText = null; }
    const readyVisits = queueText === null ? [] : queueReadyVisits(queueText, fold.jobs, now);
    const visits = [...fold.visits, ...readyVisits];
    const existing = await readQueueVisits(journalPath);
    const plan = planVisitSync(visits, existing);
    let appended = 0;
    let compacted = false;
    let dropped = 0;
    if (parsed.apply) {
      for (const visit of plan.append) { await recordQueueVisit(visit, journalPath); appended++; }
      // Same bound the daemon pass enforces: the derived visits are the keys
      // still provable from the evidence windows, so they always survive.
      const compaction = await compactQueueVisits(journalPath, {
        now, keepKeys: new Set(visits.filter(isQueueVisit).map(queueVisitKey)),
      });
      compacted = compaction.compacted;
      dropped = compaction.dropped;
    }
    const byStation: Record<string, number> = {};
    for (const v of visits) byStation[v.station] = (byStation[v.station] ?? 0) + 1;
    const report = {
      schema: VISIT_SYNC_SCHEMA,
      applied: parsed.apply,
      jobs: { path: jobsPath, state: 'ok', rows: fold.rows, ignored: fold.ignored, invalid: fold.invalid },
      mergeEvents: { path: mergeEventsPath, state: mergeEventsText === null ? 'missing' : 'ok' },
      queue: { path: queuePath, state: queueText === null ? 'missing' : 'ok', readyVisits: readyVisits.length },
      journal: { path: journalPath, snapshots: existing.length, compacted, dropped },
      derived: { visits: visits.length, byStation },
      plan: { append: plan.append.length, unchanged: plan.unchanged, regression: plan.regression, appended },
    };
    if (parsed.json) { console.log(JSON.stringify(report)); return 0; }
    console.log(`queue visits-sync: ${visits.length} derived (${Object.entries(byStation).map(([s, n]) => `${s}=${n}`).join(' ') || 'none'})`);
    console.log(`journal: ${existing.length} snapshots; plan append=${plan.append.length} unchanged=${plan.unchanged} regression=${plan.regression}${parsed.apply ? ` appended=${appended}${compacted ? ` compacted (dropped ${dropped})` : ''}` : ' (dry run; pass --apply to write)'}`);
    if (queueText === null) console.log(`queue file unreadable at ${queuePath}; live READY visits skipped`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue visit sync failed';
    if (parsed.json) console.log(JSON.stringify({ schema: VISIT_SYNC_SCHEMA, error: message }));
    else console.error(`queue visits-sync: ${message}`);
    return 1;
  }
}
