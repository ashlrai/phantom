/** Derive an outage message from the existing fleet and account snapshots. */
export function claudeIdle({ claudeLane, lanes, usedPercent, resetsAt, nowMs }: {
  claudeLane: unknown;
  lanes: readonly { lane: string; running: number | null; target: number | null }[];
  usedPercent: number | null;
  resetsAt: string | null;
  nowMs: number;
}): { downSinceMs: number | null; downHours: number | null; idleSlots: number | null; windowLeftPercent: number | null; hoursToReset: number | null; text: string; tone: 'danger' | 'warn' } | null {
  if (typeof claudeLane !== 'string' || !/^down/i.test(claudeLane)) return null;
  const lane = lanes.find((item) => item.lane === 'claude');
  if (!lane || lane.target === null || lane.target <= 0) return null;

  const stamp = claudeLane.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i)?.[0];
  const parsed = stamp ? Date.parse(stamp.replace(' ', 'T')) : NaN;
  const downSinceMs = Number.isFinite(parsed) ? parsed : null;
  const downHours = downSinceMs === null ? null : Math.max(0, (nowMs - downSinceMs) / 3_600_000);
  const idleSlots = lane.running === null ? null : lane.target - lane.running;
  const windowLeftPercent = usedPercent !== null && Number.isFinite(usedPercent) ? 100 - usedPercent : null;
  const resetMs = resetsAt === null ? NaN : Date.parse(resetsAt);
  const hoursToReset = Number.isFinite(resetMs) ? (resetMs - nowMs) / 3_600_000 : null;
  const parts = [downHours === null ? 'Lane down' : `Lane down ${downHours.toFixed(1)} h`];
  if (idleSlots !== null) parts.push(`${idleSlots} ${idleSlots === 1 ? 'slot' : 'slots'} idle`);
  if (windowLeftPercent !== null) parts.push(`${Number(windowLeftPercent.toFixed(1))}% of the weekly window unused`);
  if (hoursToReset !== null) {
    const reset = new Date(resetMs);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][reset.getDay()];
    parts.push(`resets ${day} ${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`);
  }
  return {
    downSinceMs, downHours, idleSlots, windowLeftPercent, hoursToReset, text: parts.join(' · '),
    tone: (downHours !== null && downHours >= 1) || (hoursToReset !== null && hoursToReset <= 24 && windowLeftPercent !== null && windowLeftPercent >= 50) ? 'danger' : 'warn',
  };
}
