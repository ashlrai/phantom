/** `phm ci-metrics` — per-repo daily turn-time (red→green) metrics.
 *
 * Reads GitHub Actions schedule runs, matches red (failing) runs to the
 * next green (passing) one, and computes `daily_ttg_s` (seconds).
 *
 * Writes `~/.ashlr/ci-metrics.json` with the computed results.
 * Target: 7200s (2 hours).
 */
import { computeDailyTtgS, loadExistingMetrics, saveMetrics, type CiMetricEntry, type CiMetrics, DAILY_TTG_TARGET_S } from '../core/ci-metrics.js';

const USAGE = 'usage: phm ci-metrics [--json]';

export async function cmdCiMetrics(args: string[], deps: { gh?: (args: string[]) => Promise<string> } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const extra = args.filter(a => a !== '--json');
  if (extra.length > 0) { console.error(USAGE); return 2; }
  try {
    const repos = await computeDailyTtgS(deps.gh as (args: string[]) => Promise<string>);
    const existing = await loadExistingMetrics();
    const merged: Record<string, CiMetricEntry> = { ...(existing?.repos || {}) };
    for (const [repo, entry] of Object.entries(repos)) {
      if (entry.daily_ttg_s === null && merged[repo] && entry.lastRedRunId === merged[repo].lastRedRunId) {
        // Reuse a known pair only when this read has no fresh measurement.
        entry.daily_ttg_s = merged[repo].daily_ttg_s;
        entry.lastGreenRunId = merged[repo].lastGreenRunId;
      }
      merged[repo] = entry;
    }
    const metrics: CiMetrics = {
      v: 1,
      generatedAt: new Date().toISOString(),
      target_s: DAILY_TTG_TARGET_S,
      repos: merged,
    };
    const written = await saveMetrics(metrics);
    if (json) console.log(JSON.stringify({ ...metrics, path: written }, null, 2));
    else {
      console.log(`Wrote ${written}`);
      const reposList = Object.values(merged);
      const flagged = reposList.filter(r => r.daily_ttg_s !== null && r.daily_ttg_s > DAILY_TTG_TARGET_S);
      if (flagged.length > 0) {
        console.log(`\nFlagged (exceeds ${DAILY_TTG_TARGET_S}s target):`);
        for (const r of flagged) console.log(`  ${r.repo}: ${r.daily_ttg_s}s`);
      } else {
        console.log('All repos within ' + DAILY_TTG_TARGET_S + 's target.');
      }
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'ci-metrics: unable to compute.');
    return 1;
  }
}
