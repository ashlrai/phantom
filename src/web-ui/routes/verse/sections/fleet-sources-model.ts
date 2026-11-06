type Id = 'runsDir' | 'workers' | 'inbox' | 'codex' | 'merges';
type State = 'healthy' | 'degraded' | 'missing' | 'not-landed' | 'unknown';
type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const labels: Record<Id, string> = {
  runsDir: 'Runs directory', workers: 'Workers', inbox: 'Leaders’ inbox', codex: 'Personal Codex', merges: 'GitHub merges',
};
const specific: Partial<Record<Id, Partial<Record<State, string>>>> = {
  runsDir: { missing: 'The runs directory was not found on this Mac; start the dispatcher once to create it.' },
  workers: { degraded: 'Process listing failed; the sidecar could not run ps.' },
  inbox: { missing: 'No inbox file yet; the first message creates it.' },
  codex: { missing: 'No personal Codex session logs found.' },
  merges: { degraded: 'GitHub CLI not available or not signed in; merges in the last hour cannot be counted.' },
};
const appearance: Record<State, { word: string; tone: Tone }> = {
  healthy: { word: 'Live', tone: 'success' }, degraded: { word: 'Degraded', tone: 'warning' },
  missing: { word: 'Missing', tone: 'danger' }, 'not-landed': { word: 'Not in build', tone: 'neutral' },
  unknown: { word: '—', tone: 'neutral' },
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readFleetSources(snapshot: unknown, nowMs: number): {
  rows: Array<{ id: Id; label: string; state: State; word: string; tone: Tone; remedy: string | null }>;
  freshness: { ageSeconds: number | null; stale: boolean }; claudeLane: string | null;
} {
  const data = record(snapshot) ? snapshot : {};
  const sources = record(data.sources) ? data.sources : {};
  const rows = (Object.keys(labels) as Id[]).map(id => {
    const value = sources[id];
    const state: State = typeof value === 'string' && Object.hasOwn(appearance, value) ? value as State : 'unknown';
    const remedy = state === 'not-landed' ? 'Not part of this build.'
      : specific[id]?.[state] ?? (state === 'degraded' ? 'This source could not be read; check the sidecar and try again.'
        : state === 'missing' ? 'This source was not found on this Mac.' : null);
    return { id, label: labels[id], state, ...appearance[state], remedy };
  });
  const generated = typeof data.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
  const ageSeconds = Number.isFinite(generated) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - generated) / 1000)) : null;
  const claudeLane = typeof data.claudeLane === 'string' && /^[\w .-]{1,80}$/.test(data.claudeLane) ? data.claudeLane : null;
  return { rows, freshness: { ageSeconds, stale: ageSeconds !== null && nowMs - generated > 30_000 }, claudeLane };
}
