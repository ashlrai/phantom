import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

type Tone = 'ok' | 'warn' | 'bad';

function hostLoadTone(ratio: number | null): 'unknown' | Tone {
  return ratio === null ? 'unknown' : ratio < 1.5 ? 'ok' : ratio < 4 ? 'warn' : 'bad';
}

export function hostView(runs: FleetRuns | null, nowMs: number) {
  const pct = runs?.memFreePct ?? null;
  const gb = runs?.diskFreeGb ?? null;
  const at = runs?.lastTick ? Date.parse(runs.lastTick) : NaN;
  const ageSeconds = Number.isFinite(at) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - at) / 1000) : null;
  const memoryTone: Tone = pct === null ? 'ok' : pct < 10 ? 'bad' : pct < 25 ? 'warn' : 'ok';
  const diskTone: Tone = gb === null ? 'ok' : gb < 5 ? 'bad' : gb < 20 ? 'warn' : 'ok';
  const tickTone: Tone = ageSeconds === null ? 'ok' : ageSeconds > 20 * 60 ? 'bad' : ageSeconds > 5 * 60 ? 'warn' : 'ok';
  const lane = runs?.claudeLane ?? null;
  const load = runs?.host;
  const ratio = load?.ratio ?? null;
  const text = load?.load1 == null || load.cores == null || ratio === null
    ? 'Load unknown' : `Load ${load.load1} on ${load.cores} cores (${ratio.toFixed(1)}×)`;
  const tone = hostLoadTone(ratio);
  return {
    load: { ratio, text, caption: tone === 'unknown' ? 'Unknown' : tone, tone },
    memory: { pct, tone: memoryTone },
    disk: { gb, text: gb === null ? '—' : `${gb} GB`, tone: diskTone },
    tick: { ageSeconds, text: ageSeconds === null ? '—' : `${ageText(ageSeconds)} ago`, tone: tickTone },
    paused: runs?.paused ?? null,
    switches: runs?.switches ?? [],
    claudeLane: { text: lane ?? 'Unknown', down: lane !== null && /^down/i.test(lane) },
    orchestratorAgents: runs?.orchestratorAgents ?? null,
  };
}
