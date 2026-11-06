import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { ackState, newestLeaderPassMs } from '../fleet/interject-ack-model.js';
import { nextPassEta } from '../fleet/next-pass-eta.js';
import { LEADER_PASS_CADENCE_MS } from '../shell/fleet-needs-you.js';

export function mobileTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function mobileAckLine(postedAtMs: number | null, snapshot: FleetRunsV1 | undefined, nowMs: number):
  { text: string; tone: 'neutral' | 'ok' | 'warning' } | null {
  if (postedAtMs === null || !Number.isFinite(postedAtMs)) return null;
  const landed = `Landed in the inbox ${mobileTime(new Date(postedAtMs).toISOString())}`;
  const pass = newestLeaderPassMs(snapshot?.leaders, Date.parse(snapshot?.generatedAt ?? ''));
  if (ackState(postedAtMs, pass) === 'seen' && pass !== null) {
    return { text: `Read by the ${mobileTime(new Date(pass).toISOString())} pass`, tone: 'ok' };
  }
  if (pass !== null && nowMs - pass > 2 * LEADER_PASS_CADENCE_MS) {
    return { text: `${landed} · No leader pass for ${Math.floor((nowMs - pass) / 60_000)} min`, tone: 'warning' };
  }
  const eta = nextPassEta(pass, nowMs, LEADER_PASS_CADENCE_MS);
  const next = eta.kind === 'unknown' ? 'next leader pass time unknown' : eta.kind === 'overdue'
    ? `next leader pass overdue by ${eta.minutes} min` : `next leader pass due in about ${eta.minutes} min`;
  return { text: `${landed} · ${next}`, tone: 'neutral' };
}
