import type { OpsExperimentV1, OpsFleetV1 } from '../../../../core/verse/ops-types.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { forestVerdict, type ForestRow } from '../../../components/charts/ForestPlot.js';

export function experimentRows(fleet: OpsFleetV1): { rows: ForestRow[]; summary: { total: number; helped: number; hurt: number; unclear: number; unknown: number }; status: ChartStatus } {
  const sorted = [...fleet.experiments].sort((a, b) => {
    const active = (e: OpsExperimentV1) => e.status === 'running' || e.status === 'active';
    const date = (e: OpsExperimentV1) => e.finishedAt ? Date.parse(e.finishedAt) || 0 : 0;
    return Number(active(b)) - Number(active(a)) || date(b) - date(a) || a.id.localeCompare(b.id);
  });
  const rows = sorted.map((e): ForestRow => ({
    id: e.id, label: `${e.arms.base} → ${e.arms.candidate}`,
    estimate: e.lift?.mean ?? null, low: e.lift?.ciLow ?? null, high: e.lift?.ciHigh ?? null,
    n: e.pairs, detail: `${e.wins}W ${e.losses}L ${e.ties}T · ${e.status}${e.verdict ? ` · ${e.verdict}` : ''}`,
  }));
  const summary = { total: rows.length, helped: 0, hurt: 0, unclear: 0, unknown: 0 };
  for (const row of rows) {
    const verdict = forestVerdict(row);
    summary[verdict === 'positive' ? 'helped' : verdict === 'negative' ? 'hurt' : verdict === 'none' ? 'unclear' : 'unknown']++;
  }
  return { rows, summary, status: rows.length ? { kind: 'ready' } : { kind: 'empty', message: 'No calibration experiments yet.' } };
}

export function experimentNotes(exp: OpsExperimentV1): string[] {
  return [...exp.reasons, ...(exp.startedAt ? [`Started: ${exp.startedAt}`] : []), ...(exp.finishedAt ? [`Finished: ${exp.finishedAt}`] : [])];
}
