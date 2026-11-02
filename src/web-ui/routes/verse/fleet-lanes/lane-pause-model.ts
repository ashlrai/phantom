export const LANE_PAUSE_KEY = 'phantom.lane-pause.v1';
export type PauseRecord = Record<string, number>;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function parsePauseRecord(raw: string | null): PauseRecord {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, target]) => positive(target)));
  } catch { return {}; }
}

export function pauseTransition(lane: string, currentTarget: number, remembered: PauseRecord) {
  return { target: 0, record: positive(currentTarget) ? { ...remembered, [lane]: currentTarget } : { ...remembered } };
}

export function resumeTransition(lane: string, remembered: PauseRecord, floor = 0, pausedFrom?: number | null) {
  const record = { ...remembered };
  const target = positive(record[lane]) ? record[lane]
    : positive(pausedFrom) && pausedFrom > floor ? pausedFrom
    : positive(floor) ? floor : 1;
  delete record[lane];
  return { target, record };
}

export function pauseLabel(lane: string, record: PauseRecord, pausedFrom?: number | null): string | null {
  const value = positive(record[lane]) ? record[lane] : positive(pausedFrom) ? pausedFrom : null;
  return value ? `Paused · was ${value}` : null;
}
