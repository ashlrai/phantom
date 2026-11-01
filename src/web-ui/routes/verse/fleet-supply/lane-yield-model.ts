import { asRecord } from './supply-model.js';

export interface LaneYield {
  lane: string;
  tokensLastHour: number | null;
  merged24h: number | null;
  mergeRate24h: number | null;
  tokensPerMerge: number | null;
}

export interface RankedLaneYield extends LaneYield {
  hint: 'lower the target' | 'raise the target' | 'watch';
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function laneYield(value: unknown): LaneYield {
  const lane = asRecord(value);
  const tokensLastHour = finite(lane.tokensLastHour);
  const merged24h = finite(lane.merged24h);
  const mergeRate24h = finite(lane.mergeRate24h);
  return {
    lane: typeof lane.lane === 'string' ? lane.lane : '',
    tokensLastHour, merged24h, mergeRate24h,
    tokensPerMerge: tokensLastHour !== null && mergeRate24h !== null && mergeRate24h > 0
      ? tokensLastHour / mergeRate24h : null,
  };
}

function formatTokens(value: number): string {
  const magnitude = Math.abs(value);
  const divisor = magnitude >= 1_000_000 ? 1_000_000 : magnitude >= 1_000 ? 1_000 : 1;
  const scaled = value / divisor;
  const suffix = divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'k' : '';
  return `${new Intl.NumberFormat('en-US', Math.abs(scaled) < 10 ? { maximumFractionDigits: 1 } : { maximumSignificantDigits: 2 }).format(scaled)}${suffix}`;
}

export function yieldText(yieldRow: LaneYield): string {
  const tokens = yieldRow.tokensLastHour === null ? 'tokens unknown' : `${formatTokens(yieldRow.tokensLastHour)} tokens/h`;
  if (yieldRow.merged24h === 0) return `${tokens} · no merges in 24 h`;
  const merges = yieldRow.merged24h === null ? 'merges unknown' : `${yieldRow.merged24h} merged in 24 h`;
  const rate = yieldRow.mergeRate24h === null ? '' : ` (${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(yieldRow.mergeRate24h)}/h)`;
  const perMerge = yieldRow.tokensPerMerge === null ? '' : ` · about ${formatTokens(yieldRow.tokensPerMerge)} tokens per merge`;
  return `${tokens} · ${merges}${rate}${perMerge}`;
}

export function yieldRanking(rows: readonly unknown[]): RankedLaneYield[] {
  const spending = rows.map(value => ({ source: asRecord(value), yieldRow: laneYield(value) }))
    .filter(({ yieldRow }) => yieldRow.lane && yieldRow.tokensLastHour !== null && yieldRow.tokensLastHour > 0);
  const best = Math.min(...spending.flatMap(({ yieldRow }) => yieldRow.tokensPerMerge === null ? [] : [yieldRow.tokensPerMerge]));
  return spending.sort((a, b) => {
    const left = a.yieldRow.tokensPerMerge;
    const right = b.yieldRow.tokensPerMerge;
    if (left === null) return right === null ? 0 : -1;
    if (right === null) return 1;
    return right - left;
  }).slice(0, 4).map(({ source, yieldRow }) => {
    const running = finite(source.running);
    const target = finite(source.target);
    const queued = finite(source.queued);
    const hint = yieldRow.merged24h === 0 && running !== null && target !== null && running >= target
      ? 'lower the target' : queued !== null && queued > 0 && yieldRow.tokensPerMerge !== null && yieldRow.tokensPerMerge === best
        ? 'raise the target' : 'watch';
    return { ...yieldRow, hint };
  });
}
