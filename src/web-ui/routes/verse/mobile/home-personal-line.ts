/** Format the personal Codex usage from the fleet snapshot for Home. */
export function personalLine(runs: unknown, nowMs: number): { title: string; trailing: string; tone: 'neutral' | 'warning' | 'danger' } | null {
  // Reset times are absolute, so the display does not depend on the current time.
  void nowMs;
  if (typeof runs !== 'object' || runs === null || !('codexPersonal' in runs)) return null;
  const codex = runs.codexPersonal;
  if (typeof codex !== 'object' || codex === null || !('usedPct' in codex)
    || typeof codex.usedPct !== 'number' || !Number.isFinite(codex.usedPct)) return null;

  const pct = codex.usedPct;
  const reset = 'resetsAt' in codex && typeof codex.resetsAt === 'string' ? Date.parse(codex.resetsAt) : NaN;
  const resetText = Number.isFinite(reset)
    ? ` · resets ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(reset).replace(',', '')} ET`
    : '';
  return { title: 'Personal Codex', trailing: `${pct}% used${resetText}`, tone: pct >= 95 ? 'danger' : pct >= 85 ? 'warning' : 'neutral' };
}
