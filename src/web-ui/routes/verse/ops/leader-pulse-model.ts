export interface LeaderPulseInput {
  v: 1;
  generatedAt: string;
  lastTick: string | null;
  paused: boolean | null;
  claudeLane: string | null;
  leaders: Array<{ label: string; ageSeconds: number | null }>;
  orchestratorAgents: number | null;
  drop: { pending: Array<{ lane: string; file: string }>; done: number } | null;
  sources: { runsDir: 'healthy' | 'degraded' | 'missing' | 'not-landed' };
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function readLeaderPulse(raw: unknown): LeaderPulseInput | null {
  if (!record(raw) || raw.v !== 1 || !instant(raw.generatedAt)
    || !(raw.lastTick === null || instant(raw.lastTick))
    || !(raw.paused === null || typeof raw.paused === 'boolean')
    || !(raw.claudeLane === null || typeof raw.claudeLane === 'string')
    || !Array.isArray(raw.leaders) || !raw.leaders.every(row => record(row) && typeof row.label === 'string'
      && (row.ageSeconds === null || (typeof row.ageSeconds === 'number' && Number.isFinite(row.ageSeconds) && row.ageSeconds >= 0 && row.ageSeconds <= Number.MAX_SAFE_INTEGER / 1000)))
    || !(raw.orchestratorAgents === null || count(raw.orchestratorAgents))
    || !(raw.drop === null || (record(raw.drop) && count(raw.drop.done) && Array.isArray(raw.drop.pending)
      && raw.drop.pending.every(row => record(row) && typeof row.lane === 'string' && typeof row.file === 'string')))
    || !record(raw.sources) || typeof raw.sources.runsDir !== 'string'
    || !['healthy', 'degraded', 'missing', 'not-landed'].includes(raw.sources.runsDir)) return null;
  return raw as unknown as LeaderPulseInput;
}

export const STALE_LEADER_MS = 20 * 60_000;

export function leaderRows(input: LeaderPulseInput, nowMs: number): Array<{ label: string; ageMs: number | null; tone: 'good' | 'warn' | 'unknown' }> {
  const elapsed = Math.max(0, nowMs - Date.parse(input.generatedAt));
  return input.leaders.map(({ label, ageSeconds }) => {
    const ageMs = ageSeconds === null ? null : ageSeconds * 1000 + elapsed;
    return { label, ageMs, tone: ageMs === null ? 'unknown' : ageMs >= STALE_LEADER_MS ? 'warn' : 'good' };
  });
}

export function formatPulseAge(ageMs: number | null): string {
  if (ageMs === null) return '—';
  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function dropRows(input: LeaderPulseInput): Array<{ lane: string; pending: number; files: string[] }> {
  const lanes = new Map<string, string[]>();
  for (const row of input.drop?.pending ?? []) {
    const files = lanes.get(row.lane) ?? [];
    files.push(row.file.split(/[\\/]/).pop() ?? '');
    lanes.set(row.lane, files);
  }
  return [...lanes].sort(([a], [b]) => a.localeCompare(b)).map(([lane, files]) => ({ lane, pending: files.length, files }));
}

export function claudeLaneNote(claudeLane: string | null): string | null {
  return claudeLane !== null && /^down/i.test(claudeLane) ? claudeLane : null;
}

export function pulseHeadline(input: LeaderPulseInput, nowMs: number): string {
  const rows = leaderRows(input, nowMs);
  const ages = rows.flatMap(row => row.ageMs === null ? [] : [row.ageMs]);
  const parts = [`${rows.length} ${rows.length === 1 ? 'leader' : 'leaders'}${ages.length ? `, newest pass ${formatPulseAge(Math.min(...ages))}` : ''}`];
  if (input.orchestratorAgents !== null) parts.push(`${input.orchestratorAgents} ${input.orchestratorAgents === 1 ? 'agent' : 'agents'}`);
  if (input.lastTick !== null) parts.push(`tick ${formatPulseAge(Math.max(0, nowMs - Date.parse(input.lastTick)))}`);
  return `${input.paused === true ? 'Dispatcher paused · ' : ''}${parts.join(' · ')}`;
}
