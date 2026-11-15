export function updateImpact(jobs: number | null, workersOutsideApp: boolean | null, updateAvailable: boolean): { text: string; tone: 'ok' | 'warn' } | null {
  if (!updateAvailable) return null;
  if (jobs === null) return { text: 'Fleet job count unavailable. Unknown whether a restart interrupts jobs.', tone: 'warn' };
  if (jobs === 0) return { text: 'No fleet jobs running.', tone: 'ok' };
  return workersOutsideApp === true
    ? { text: `${jobs} fleet jobs running. Installing restarts only the app; jobs keep running.`, tone: 'ok' }
    : { text: `${jobs} fleet jobs running. Unknown whether a restart interrupts them.`, tone: 'warn' };
}
