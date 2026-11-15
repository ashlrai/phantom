/**
 * `ashlr fleet surface-owner <surface> [--json]` — who owns a named surface
 * (Slack bridge, iMessage bridge, Dot handoff, coordination ledger) right
 * now, with evidence: the live advisory claims naming it plus the newest
 * landed fleet job and PR that touched its paths on origin/master. Read-only;
 * claims coordinate only and grant no authority. See
 * src/core/fleet/surface-owner.ts.
 */
import { readFleetBoard } from '../core/fleet/coordination.js';
import { readSurfaceOwner, SURFACES, type SurfaceOwnerDeps } from '../core/fleet/surface-owner.js';
import { gitSurfaceLog } from '../core/fleet/surface-owner-git-log.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet surface-owner (${Object.keys(SURFACES).join('|')}) [--json]`;
const HISTORY_BUDGET_MS = 5_000;

export async function cmdFleetSurfaceOwner(args: string[], deps: SurfaceOwnerDeps & { historyBudgetMs?: number } = {}): Promise<number> {
  let surface: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !seen.has(arg)) { json = true; seen.add(arg); continue; }
    if (!arg.startsWith('-') && surface === undefined) { surface = arg; continue; }
    console.error(usage);
    return 2;
  }
  if (surface === undefined || !Object.hasOwn(SURFACES, surface)) { console.error(usage); return 2; }
  const budget = deps.historyBudgetMs;
  const deadline = performance.now() + (budget !== undefined && Number.isFinite(budget) && budget >= 0 ? budget : HISTORY_BUDGET_MS);
  const log = deps.log ?? gitSurfaceLog;
  const boundedLog: NonNullable<SurfaceOwnerDeps['log']> = async (...params) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('history deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => log!(...params)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('history deadline exceeded')), remaining); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const report = await readSurfaceOwner(surface, {
    now: deps.now,
    board: deps.board ?? readFleetBoard,
    log: boundedLog,
  });
  const safe = sanitizePublicJson(report) as NonNullable<typeof report>;
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    console.log([
      `surface: ${safe.surface}; owner: ${safe.owner}; source: ${safe.ownerSource}`,
      `live claims: ${safe.liveClaims.length ? safe.liveClaims.map(c => `${c.id} (${c.agent}, expires in ${c.expiresInSeconds}s)`).join(', ') : 'none'}`,
      `last landed: ${safe.lastLanded ? `${safe.lastLanded.jobId} ${safe.lastLanded.pr === null ? '#?' : `#${safe.lastLanded.pr}`} ${safe.lastLanded.date} ${safe.lastLanded.path}` : 'none in scanned paths'}`,
      `asOf: ${safe.asOf}${safe.reasons.length ? `; ${safe.reasons.join('; ')}` : ''}`,
    ].join('\n'));
  }
  return 0;
}
