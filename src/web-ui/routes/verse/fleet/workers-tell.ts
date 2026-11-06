import { ageText } from './workers-card-model.js';

export function workerTellPrefill(w: { job: string; lane: string; ageSeconds: number | null; repo?: string | null }): string {
  return `Re ${w.job} (${w.lane}${w.repo ? `, ${w.repo}` : ''}): running ${w.ageSeconds === null ? 'age unknown' : ageText(w.ageSeconds)} with no PR, looks stuck. `;
}
