/**
 * planner-slate-propose.ts — a ready-to-declare planner slate, read-only.
 *
 * Declaring `queue/planner-candidates.json` names a leader seat's argv, so it
 * is Security's call. This builds the proposal: every pool in the resource
 * ledger that has usage left and a known runner (the argv templates in
 * planner-slate-presets.ts), soonest reset first, so the pool that would
 * otherwise go unused leads. It never writes the file, never reads the
 * environment, and the argv carries only paths the templates already name.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPoolsView, type PoolRow } from './pools-view.js';
import { parsePlannerSlate, type Slate } from './planner-slate-write.js';
import {
  PLANNER_SLATE_PRESETS, defaultPlannerBriefPath, resolvePlannerPreset, type PlannerPresetId,
} from './planner-slate-presets.js';
import { PLANNER_CANDIDATES_FILE, readPlannerCandidates, type PlannerCandidatesSource } from './planner-candidates.js';
import { readResourceLedger } from './runs-resource-ledger.js';
import { readUsageSamples } from './usage-history.js';

export interface PlannerSlateProposalLane { provider: string; usedPct: number | null; resetAt: string | null; why: string }
export interface PlannerSlateProposal {
  v: 1;
  /** State of the file today: the proposal never touches it. */
  current: PlannerCandidatesSource;
  /** The v1 slate to declare; null when no pool qualifies. */
  slate: Slate | null;
  lanes: PlannerSlateProposalLane[];
  /** Pools left out, with the reason in plain words. */
  skipped: { pool: string; why: string }[];
  /** Plain-word caveats (no brief on disk, nothing qualifies). */
  notes: string[];
}

const isPreset = (id: string): id is PlannerPresetId => (PLANNER_SLATE_PRESETS as readonly string[]).includes(id);
const resetMs = (row: PoolRow): number => { const ms = Date.parse(row.resetAt ?? ''); return Number.isFinite(ms) ? ms : Infinity; };

export async function proposePlannerSlate(
  opts: { runsDir?: string; home?: string; now?: number; exists?: (path: string) => boolean } = {},
): Promise<PlannerSlateProposal> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const [current, view] = await Promise.all([
    readPlannerCandidates(runsDir).then((r) => r.source),
    readResourceLedger({ runsDir, now: () => now })
      .then(async (ledger) => buildPoolsView(ledger, now, await readUsageSamples({ runsDir, nowMs: now })))
      .catch(() => null),
  ]);
  const notes: string[] = [];
  const skipped: PlannerSlateProposal['skipped'] = [];
  const picked: { row: PoolRow; argv: string[] }[] = [];
  if (view === null) notes.push('The resource ledger could not be read, so no pool state is known.');
  for (const row of view?.pools ?? []) {
    if (!isPreset(row.id)) { skipped.push({ pool: row.id, why: 'no runner command is on file for this lane' }); continue; }
    if (row.kind === 'credits') { skipped.push({ pool: row.id, why: 'a credit balance, not a usage pool' }); continue; }
    if (row.state === 'unknown') { skipped.push({ pool: row.id, why: row.reason ?? 'no current usage reading' }); continue; }
    if (row.usedPct !== null && row.usedPct >= 100) { skipped.push({ pool: row.id, why: 'out of usage until its reset' }); continue; }
    const preset = resolvePlannerPreset(row.id, { home, runsRoot: runsDir, ...(opts.exists ? { exists: opts.exists } : {}) });
    if (!preset.available) { skipped.push({ pool: row.id, why: 'its runner is not installed on this Mac' }); continue; }
    picked.push({ row, argv: preset.argv });
  }
  picked.sort((a, b) => resetMs(a.row) - resetMs(b.row) || (a.row.id < b.row.id ? -1 : 1));
  const lanes = picked.map(({ row }): PlannerSlateProposalLane => ({
    provider: row.id, usedPct: row.usedPct, resetAt: row.resetAt,
    why: row.usedPct === null ? 'usage left' : `${Math.round(100 - row.usedPct)}% of the pool left`,
  }));
  if (picked.length === 0) {
    notes.push('No pool with usage left has a known runner, so there is nothing to propose.');
    return { v: 1, current, slate: null, lanes, skipped, notes };
  }
  const promptPath = defaultPlannerBriefPath(runsDir, opts.exists);
  const draft = { v: 1, candidates: picked.map(({ row, argv }) => ({ provider: row.id, argv })), ...(promptPath === null ? {} : { promptPath }) };
  const slate = parsePlannerSlate(Buffer.from(JSON.stringify(draft)));
  if (slate === null) {
    notes.push('The proposed list failed the slate checks, so it is withheld.');
    return { v: 1, current, slate: null, lanes, skipped, notes };
  }
  if (promptPath === null) notes.push('No planner brief file was found, so the slate names no promptPath; a pass will skip until one is declared.');
  notes.push(`Read-only: nothing was written. Security declares it by saving the slate to ${PLANNER_CANDIDATES_FILE} (phm fleet planner-slate --file <abs>).`);
  return { v: 1, current, slate, lanes, skipped, notes };
}
