import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

type Tone = 'ok' | 'warn' | 'bad';

export function hostView(runs: FleetRuns | null, nowMs: number) {
  const pct = runs?.memFreePct ?? null;
  const gb = runs?.diskFreeGb ?? null;
  const at = runs?.lastTick ? Date.parse(runs.lastTick) : NaN;
  const ageSeconds = Number.isFinite(at) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - at) / 1000) : null;
  const memoryTone: Tone = pct === null ? 'ok' : pct < 10 ? 'bad' : pct < 25 ? 'warn' : 'ok';
  const diskTone: Tone = gb === null ? 'ok' : gb < 5 ? 'bad' : gb < 20 ? 'warn' : 'ok';
  const tickTone: Tone = ageSeconds === null ? 'ok' : ageSeconds > 20 * 60 ? 'bad' : ageSeconds > 5 * 60 ? 'warn' : 'ok';
  const lane = runs?.claudeLane ?? null;
  return {
    memory: { pct, tone: memoryTone },
    disk: { gb, text: gb === null ? '—' : `${gb} GB`, tone: diskTone },
    tick: { ageSeconds, text: ageSeconds === null ? '—' : `${ageText(ageSeconds)} ago`, tone: tickTone },
    paused: runs?.paused ?? null,
    switches: runs?.switches ?? [],
    claudeLane: { text: lane ?? 'Unknown', down: lane !== null && /^down/i.test(lane) },
    orchestratorAgents: runs?.orchestratorAgents ?? null,
  };
}
