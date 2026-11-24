/** Pure explanation of observed blockers; never infers a limit from missing readings. */
export interface WhyIdleBrief {
  at: string;
  lanes?: readonly { lane: string; running: number | null; target: number | null; held: boolean | null; pause_new_until?: number | null; queuedReady?: number | null }[];
  pools?: readonly { pool: string; usedPct: number | null; verdict: string }[];
  attention?: readonly { lane: string; status: string }[];
  admission?: { lastWhy?: string | null; settleSeconds?: number | null; startsPerHour?: number | null } | null;
}
const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const name = (id: string): string => /local/.test(id) ? 'Local models' : /codex|personal/.test(id) ? 'Codex'
  : /claude/.test(id) ? 'Claude' : /gemini|agy/.test(id) ? 'Gemini' : /devin/.test(id) ? 'Devin'
    : /grok/.test(id) ? 'Grok' : /cursor/.test(id) ? 'Cursor' : /zai/.test(id) ? 'Zai' : 'Other workers';

/** Holds, host limits, fast spending, empty queues, then stuck jobs; at most three. */
export function whyIdle(brief: WhyIdleBrief): string[] {
  const lanes = brief.lanes ?? [], pools = brief.pools ?? [], reasons: string[] = [];
  if (lanes.length && lanes.every(l => known(l.running) && known(l.target) && l.target > 0 && l.running >= l.target)) return [];
  const blocked = new Set<string>();
  const over = (label: string) => pools.find(p => name(p.pool) === label && p.verdict === 'over' && known(p.usedPct));
  const spending = (p: NonNullable<ReturnType<typeof over>>) => `${known(p.usedPct) ? `${Math.round(p.usedPct)}% used, ` : ''}spending too fast`;
  for (const l of lanes) {
    const paused = known(l.pause_new_until) && l.pause_new_until > Date.parse(brief.at) / 1000 && l.pause_new_until * 1000 <= 8.64e15;
    if ((!l.held && !paused) || (known(l.running) && known(l.target) && l.target > 0 && l.running >= l.target)) continue;
    const label = name(l.lane), pool = over(label);
    const until = paused ? ` until ${new Date(l.pause_new_until! * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC` : '';
    reasons.push(`${label} ${paused ? 'paused' : 'on hold'}${until}: ${known(l.running) ? `${l.running} running` : '0 new starts'}${pool ? `; ${spending(pool)}` : ''}`);
    blocked.add(label);
  }
  const a = brief.admission;
  if (/\bover_(?:host|owned)\b/.test(a?.lastWhy ?? '')) {
    reasons.push(`Computer too busy: 0 new starts${known(a?.startsPerHour) ? `, ${Math.round(a.startsPerHour)} starts per hour recently` : ''}`);
  } else if (/settle/i.test(a?.lastWhy ?? '') && known(a?.settleSeconds) && a.settleSeconds > 0) {
    const spacing = a.settleSeconds < 60 ? `${a.settleSeconds} sec` : `about ${Math.round(a.settleSeconds / 6) / 10} min`;
    reasons.push(`Starts spaced ${spacing} apart after load spikes`);
  }
  for (const p of pools) if (p.verdict === 'over' && known(p.usedPct) && !blocked.has(name(p.pool))) {
    reasons.push(`${name(p.pool)}: ${spending(p)}`); blocked.add(name(p.pool));
  }
  for (const l of lanes) if (l.held === false && !blocked.has(name(l.lane)) && l.queuedReady === 0 && known(l.running) && known(l.target) && l.running < l.target) {
    reasons.push(`${name(l.lane)}: ${l.target - l.running} free spots, 0 ready jobs`);
  }
  const stuck = new Map<string, number>();
  for (const j of brief.attention ?? []) if (j.status === 'stuck') stuck.set(name(j.lane), (stuck.get(name(j.lane)) ?? 0) + 1);
  for (const [label, count] of stuck) reasons.push(`${label}: ${count} stuck ${count === 1 ? 'job' : 'jobs'}`);
  return [...new Set(reasons)].slice(0, 3);
}
