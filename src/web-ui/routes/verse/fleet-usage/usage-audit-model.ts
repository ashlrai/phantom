import type { AuditLane, UsageAuditView } from './usage-audit-queries.js';

const rank = { incident: 0, idle: 1, 'insufficient-evidence': 2, 'reset-observed': 3, moving: 4 };
const tones = { incident: 'bad', idle: 'warn', 'insufficient-evidence': 'neutral', 'reset-observed': 'ok', moving: 'ok' } as const;
function deltaText(lane: AuditLane): string {
  if (lane.classification === 'insufficient-evidence' || lane.pctUsedDelta === null || lane.observedMinutes === null) return 'evidence too thin';
  if (lane.pctUsedDelta === 0) return `no movement in ${lane.observedMinutes} min`;
  return `${lane.pctUsedDelta > 0 ? '+' : ''}${Number(lane.pctUsedDelta.toFixed(1))}% in ${lane.observedMinutes} min`;
}
export function auditRows(view: UsageAuditView) {
  return [...view.lanes].sort((a, b) => rank[a.classification] - rank[b.classification] || a.lane.localeCompare(b.lane))
    .map(l => ({ lane: l.lane, verdict: l.classification, deltaText: deltaText(l), reason: l.reason, nextAction: l.nextAction, tone: tones[l.classification] }));
}
export function auditHeadline(view: UsageAuditView): string {
  if (view.sources.usageJournal.state === 'missing') return 'Zero waste: usage journal missing';
  const counts = (['incident', 'idle', 'moving'] as const).map(c => {
    const n = view.lanes.filter(l => l.classification === c).length;
    return n ? `${n} ${c === 'incident' && n !== 1 ? 'incidents' : c}` : null;
  }).filter(Boolean);
  return `Zero waste: ${counts.length ? counts.join(' · ') : 'evidence too thin'}`;
}
