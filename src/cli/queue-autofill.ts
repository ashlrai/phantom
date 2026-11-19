const USAGE = 'Usage: phm queue autofill --lane <lane> [--min <n>] [--apply] [--json]\n       phm queue autofill --status [--json]';
const LANE = /^[a-z][a-z0-9-]{0,30}$/;

export interface AutofillDeps {
  /** Running, target and queued counts for the lane; null where unknown. */
  readLane?: (lane: string) => Promise<{ running: number | null; target: number | null; queued: number | null }>;
  root?: string;
  dir?: string;
  /** Runs dir for --status (events and kill switch); the usual runs dir when unset. */
  runsDir?: string;
  now?: () => number;
  /** Source seams for tests; the live Ideas list, EMPTY-job notes and empty families when unset. */
  sources?: Pick<import('../core/fleet/autofill-run.js').RunAutofillOptions, 'readIdeas' | 'readFollowUps' | 'readStopped'>;
}

async function snapshotLane(lane: string) {
  const { getFleetLaneSnapshot } = await import('../core/fleet/lane-console.js');
  const view = (await getFleetLaneSnapshot()).lanes.find(l => l.lane === lane);
  return { running: view?.liveJobs ?? null, target: view?.slotTarget ?? null, queued: view?.queueDepth ?? null };
}

export async function cmdQueueAutofill(args: string[], deps: AutofillDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${USAGE}\n  --min defaults to the lane's slot target. Dry run unless --apply.\n  Order: open Ideas items, then "Not built" follow-ups from recent empty jobs, then bets. Stopped job families are skipped. Each row says its source.\n  --status shows the last runs, whether autofill is on, and how many bets are left this hour.\n  self-tick runs this for every starved lane (max 4 bets per lane and 12 per hour); turn it off with: phm fleet config set autofill.off 1 --reason "<why>"`);
    return 0;
  }
  let lane = '', min: number | undefined, json = false, apply = false, status = false, dir: string | undefined = deps.dir, runsDir: string | undefined = deps.runsDir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json' && !json) json = true;
    else if (a === '--apply' && !apply) apply = true;
    else if (a === '--status' && !status) status = true;
    else if (a === '--lane' && !lane) lane = args[++i] ?? '';
    else if (a === '--min' && min === undefined && /^\d{1,3}$/.test(args[i + 1] ?? '')) min = Number(args[++i]);
    else if (a === '--dir' && dir === undefined && args[i + 1]) dir = args[++i];
    else if (a === '--runs-dir' && runsDir === undefined && args[i + 1]) runsDir = args[++i];
    else { console.error(USAGE); return 2; }
  }
  try {
    if (status) {
      if (lane || apply || min !== undefined) { console.error(USAGE); return 2; }
      const { autofillStatus, autofillStatusLines } = await import('../core/fleet/autofill-run.js');
      const { runsDirOf } = await import('../core/fleet/dynconfig.js');
      const report = await autofillStatus(runsDirOf({ runsDir }), (deps.now ?? Date.now)());
      console.log(json ? JSON.stringify(report) : autofillStatusLines(report).join('\n'));
      return 0;
    }
    if (!LANE.test(lane)) { console.error(USAGE); return 2; }
    const counts = await (deps.readLane ?? snapshotLane)(lane).catch(() => ({ running: null, target: null, queued: null }));
    const { HELP_ENTRIES } = await import('./help.js');
    const { runQueueAutofill } = await import('../core/fleet/autofill-run.js');
    const { autofillLines } = await import('../core/fleet/queue-autofill.js');
    const report = await runQueueAutofill({ lane, counts, min, apply, root: deps.root ?? process.cwd(), dir, runsDir, entries: HELP_ENTRIES, ...deps.sources });
    if ('error' in report) { console.error('The lane has no slot target; pass --min <n>.'); return 2; }
    if (json) console.log(JSON.stringify(report));
    else console.log(autofillLines(report).join('\n'));
    return 0;
  } catch (error) {
    console.error(`queue autofill: ${error instanceof Error ? error.message : 'failed'}`);
    return 1;
  }
}
