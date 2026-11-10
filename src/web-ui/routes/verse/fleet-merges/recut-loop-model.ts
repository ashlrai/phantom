export interface RecutLoopView { off: boolean; lastTickAt: string | null }

export function narrowRecutLoop(raw: unknown): RecutLoopView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  if (state.v !== 1 || typeof state.off !== 'boolean' ||
      !(state.lastTickAt === null || (typeof state.lastTickAt === 'string' && Number.isFinite(Date.parse(state.lastTickAt))))) return null;
  return { off: state.off, lastTickAt: state.lastTickAt as string | null };
}

export function recutLoopLine(view: RecutLoopView, nowMs: number): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (view.off) return { text: 'Recut loop is off.', tone: 'warn' };
  if (view.lastTickAt === null) return { text: 'Recut loop has not run yet.', tone: 'muted' };
  const elapsed = Math.max(0, nowMs - Date.parse(view.lastTickAt));
  const minutes = Math.floor(elapsed / 60_000);
  const age = minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
  if (elapsed > 30 * 60_000) return { text: `Recut loop last ran ${age} ago.`, tone: 'warn' };
  return { text: `Recut loop last ran ${age} ago. 24 h recut count unavailable.`, tone: 'ok' };
}
