import type { FleetRuns } from '../ops/ops-runs-model.js';

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim().replace(/https?:\/\/\S{81,}/g, (url) => `${url.slice(0, 79)}…`);
const limit = (value: string, length: number): string => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const age = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`;
};
const elapsed = (at: string, now: number): string | null => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? `${age((now - time) / 1000)} ago` : null;
};

export function fleetDigest(runs: FleetRuns, nowMs: number): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(nowMs);
  const header = [`Phantom fleet · ${time}`];
  const tick = runs.lastTick && elapsed(runs.lastTick, nowMs);
  if (tick) header.push(`tick ${tick}`);
  const state = [...runs.switches.map((s) => `${clean(s)} on`), ...(runs.paused === null ? [] : [runs.paused ? 'paused' : 'running'])];
  if (state.length) header.push(state.join(' / '));
  const lines = [header.join(' · ')];
  if (runs.lanes.length) lines.push(`Lanes: ${runs.lanes.map((lane) => {
    const extra = [`+${lane.queued} q`];
    if (lane.held) extra.push(lane.heldReason ? `held: ${limit(clean(lane.heldReason), 40)}` : 'held');
    return `${clean(lane.lane)} ${lane.running}/${lane.target} (${extra.join(', ')})`;
  }).join(' · ')}`);
  const ages = runs.workers.flatMap((worker) => worker.ageSeconds === null ? [] : [worker.ageSeconds]);
  lines.push(`Workers: ${runs.workers.length}${ages.length ? ` · oldest ${age(Math.max(...ages))}` : ''}`);
  const counts = [...(runs.mergesLastHour.count === null ? [] : [`Merged last hour: ${runs.mergesLastHour.count}`]), `publishes: ${runs.publishesLastHour.length}`];
  lines.push(counts.join(' · '));
  if (runs.codexPersonal) {
    const parts = [];
    if (runs.codexPersonal.usedPct !== null) parts.push(`${runs.codexPersonal.usedPct} % used`);
    const reset = runs.codexPersonal.resetsAt && Date.parse(runs.codexPersonal.resetsAt);
    if (reset && Number.isFinite(reset)) parts.push(`resets in ${age((reset - nowMs) / 1000)}`);
    if (parts.length) lines.push(`Personal Codex: ${parts.join(', ')}`);
  }
  if (runs.claudeLane !== null) lines.push(`Claude lane: ${clean(runs.claudeLane)}`);
  const inbox = [...runs.inbox].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (inbox) {
    const when = elapsed(inbox.at, nowMs);
    lines.push(`Inbox: last "${limit(clean(inbox.text), 80)}" (${clean(inbox.source)}${when ? `, ${when}` : ''})`);
  }
  return limit(lines.join('\n'), 1200);
}
