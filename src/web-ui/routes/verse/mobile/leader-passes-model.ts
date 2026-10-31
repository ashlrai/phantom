import { formatDuration } from '../autonomy/format.js';
import type { Tone } from './ui-parts.js';

type SourceState = 'healthy' | 'degraded' | 'missing' | 'unknown';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const source = (value: unknown): SourceState => value === 'healthy' || value === 'degraded' || value === 'missing' ? value : 'unknown';

export function readLeaderPasses(snapshot: unknown, nowMs: number): {
  headline: string; tone: Tone; passes: Array<{ label: string; age: string }>;
  agents: number | null; lastTick: { text: string; ageMinutes: number | null };
  claudeLane: { text: string | null; down: boolean }; sourceState: SourceState;
} {
  const data = record(snapshot) ? snapshot : {};
  const sources = record(data.sources) ? data.sources : {};
  const workers = source(sources.workers);
  const runsDir = source(sources.runsDir);
  const sourceState = workers !== 'healthy' ? workers : runsDir !== 'healthy' ? runsDir : 'healthy';
  const generated = typeof data.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
  const elapsed = Number.isFinite(generated) && Number.isFinite(nowMs) ? Math.max(0, nowMs - generated) : 0;
  const validLeaders = Array.isArray(data.leaders) && data.leaders.every(record);
  const passes = validLeaders ? (data.leaders as Record<string, unknown>[]).map(pass => {
    const basename = typeof pass.label === 'string' ? pass.label.split(/[\\/]/).pop() ?? '' : '';
    const label = /^[\w.-]{1,80}$/.test(basename) && basename !== '.' && basename !== '..' ? basename : '—';
    const seconds = pass.ageSeconds;
    const age = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? formatDuration(seconds * 1000 + elapsed) : '—';
    return { label, age };
  }) : [];
  const count = data.orchestratorAgents;
  const agents = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  const tick = typeof data.lastTick === 'string' ? Date.parse(data.lastTick) : NaN;
  const ageMinutes = Number.isFinite(tick) && Number.isFinite(nowMs) && tick <= nowMs ? Math.floor((nowMs - tick) / 60_000) : null;
  const lastTick = { text: ageMinutes === null ? '—' : ageMinutes < 1 ? 'less than 1 min ago' : `${ageMinutes} min ago`, ageMinutes };
  const lane = typeof data.claudeLane === 'string' && data.claudeLane.trim() ? data.claudeLane : null;
  const claudeLane = { text: lane, down: /down/i.test(lane ?? '') };
  let headline = '—';
  let tone: Tone = 'neutral';
  if (data.paused === true) headline = 'Paused';
  else if (workers === 'healthy' && validLeaders) {
    if (passes.length) { headline = 'Leaders active'; tone = 'running'; }
    else if (ageMinutes !== null && ageMinutes > 20) { headline = `Leaders quiet for ${ageMinutes} min`; tone = 'warning'; }
    else if (ageMinutes !== null) headline = 'Between passes';
  }
  return { headline, tone, passes, agents, lastTick, claudeLane, sourceState };
}
