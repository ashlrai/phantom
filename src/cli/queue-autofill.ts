import type { QueueAutofillReport } from '../core/fleet/queue-autofill.js';

const USAGE = 'Usage: phm queue autofill --lane <lane> [--min <n>] [--apply] [--json]';
const LANE = /^[a-z][a-z0-9-]{0,30}$/;

export interface AutofillDeps {
  /** Running, target and queued counts for the lane; null where unknown. */
  readLane?: (lane: string) => Promise<{ running: number | null; target: number | null; queued: number | null }>;
  root?: string;
  dir?: string;
}

async function snapshotLane(lane: string) {
  const { getFleetLaneSnapshot } = await import('../core/fleet/lane-console.js');
  const view = (await getFleetLaneSnapshot()).lanes.find(l => l.lane === lane);
  return { running: view?.liveJobs ?? null, target: view?.slotTarget ?? null, queued: view?.queueDepth ?? null };
}

export async function cmdQueueAutofill(args: string[], deps: AutofillDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(`${USAGE}\n  --min defaults to the lane's slot target. Dry run unless --apply.`); return 0; }
  let lane = '', min: number | undefined, json = false, apply = false, dir: string | undefined = deps.dir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json' && !json) json = true;
    else if (a === '--apply' && !apply) apply = true;
    else if (a === '--lane' && !lane) lane = args[++i] ?? '';
    else if (a === '--min' && min === undefined && /^\d{1,3}$/.test(args[i + 1] ?? '')) min = Number(args[++i]);
    else if (a === '--dir' && dir === undefined && args[i + 1]) dir = args[++i];
    else { console.error(USAGE); return 2; }
  }
  if (!LANE.test(lane)) { console.error(USAGE); return 2; }
  try {
    const counts = await (deps.readLane ?? snapshotLane)(lane).catch(() => ({ running: null, target: null, queued: null }));
    const want = min ?? counts.target;
    if (want === null || want === undefined) { console.error('The lane has no slot target; pass --min <n>.'); return 2; }
    const { QueueStore } = await import('../core/queue/store.js');
    const store = new QueueStore(dir);
    const existing = (await store.read().catch(() => ({ jobs: [] }))).jobs;
    const { gatherCandidates, MAX_PROPOSE_COUNT, proposeBets, readRepoName } = await import('../core/fleet/bets-propose.js');
    const { helpItems, readApiRoutes, readDocHeadings, readPanes } = await import('../core/fleet/bets-check.js');
    const { HELP_ENTRIES } = await import('./help.js');
    const { planAutofill, autofillLines } = await import('../core/fleet/queue-autofill.js');
    const root = deps.root ?? process.cwd();
    const entries = HELP_ENTRIES.map(e => ({ cmd: e.cmd, desc: e.desc }));
    // Ask for the most proposals; the plan takes only the gap after dropping duplicates.
    const proposed = counts.queued !== null && want > counts.queued
      ? proposeBets(gatherCandidates(root, entries), { cli: helpItems(entries), api: readApiRoutes(root), pane: readPanes(root), doc: readDocHeadings(root) }, { lane, repo: readRepoName(root), count: MAX_PROPOSE_COUNT })
      : { proposals: [], droppedGoals: [] };
    let report: QueueAutofillReport = planAutofill({ lane, min: want, ...counts, existing, proposed });
    if (apply && report.drafted.length) {
      for (const d of report.drafted) {
        await store.add({ id: d.id, status: 'READY', priority: 'P1', pool: lane, tier: d.tier, repo: d.repo, scope: d.goal, acceptance: d.acceptance, deps: [], claims: [] });
      }
      report = { ...report, applied: true };
    }
    if (json) console.log(JSON.stringify(report));
    else console.log(autofillLines(report).join('\n'));
    return 0;
  } catch (error) {
    console.error(`queue autofill: ${error instanceof Error ? error.message : 'failed'}`);
    return 1;
  }
}
