export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';

/** The trend mark people see; agents read `trend`. */
export const TREND_MARK: Record<TrendDirection, string> = { up: '↑', down: '↓', flat: '→', unknown: '?' };
