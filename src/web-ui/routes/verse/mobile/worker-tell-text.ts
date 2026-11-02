export function workerTellPrefill(w: { job: string; lane: string | null; repo: string | null; ageSeconds: number | null; pr: string | null }): string {
  const context = [w.lane, w.repo].filter((part) => part?.trim()).join(', ');
  const minutes = w.ageSeconds === null || !Number.isFinite(w.ageSeconds) || w.ageSeconds < 0 ? null : Math.floor(w.ageSeconds / 60);
  const age = minutes === null ? 'age unknown' : minutes < 1 ? '<1 min' : minutes < 60 ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `Re ${w.job}${context ? ` (${context})` : ''}: running ${age}${w.pr ? `, PR ${w.pr}` : ' with no PR'}. `;
}
