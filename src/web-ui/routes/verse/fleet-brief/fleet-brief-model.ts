import { ageText, newest, type FleetRuns } from '../ops/ops-runs-model.js';
import { isOpsReleases } from '../fleet-releases/fleet-releases-model.js';
import { releaseLine } from './release-line.js';

const limit = 2000;
const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const time = (ms: number) => Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : '—';

export function fleetBriefText(runs: FleetRuns, nowMs: number): string {
  const lanes = runs.lanes.map((lane) => `${singleLine(lane.lane)} ${lane.running}/${lane.target}${lane.held ? ` (held: ${singleLine(lane.heldReason ?? 'unspecified')})` : ''}`).join(' · ') || 'none';
  const tick = runs.lastTick === null ? NaN : Date.parse(runs.lastTick);
  const lines = [
    `Phantom fleet ${time(nowMs)} UTC`,
    `Lanes: ${lanes}`,
    `Merged last hour: ${runs.mergesLastHour.count}`,
  ];
  const merges = runs.mergesLastHour.items.slice(0, 5).map((m) => `- ${singleLine(m.repo)} #${m.number} ${singleLine(m.title)}`);
  const tail = [
    `Claude lane: ${singleLine(runs.claudeLane ?? '') || 'ok'}`,
    `Tick: ${ageText(Number.isFinite(tick) ? (nowMs - tick) / 1000 : null)}`,
    `Switches: ${runs.switches.map(singleLine).join(' · ') || 'none'}`,
  ];
  const entry = newest(runs.inbox, 1)[0];
  let inbox = entry ? `Inbox newest: ${time(Date.parse(entry.at))} ${singleLine(entry.source)}: ${singleLine(entry.text).slice(0, 120)}` : '';
  const render = () => [...lines, ...merges, ...tail, ...(inbox ? [inbox] : [])].join('\n');
  while (merges.length && render().length > limit) merges.pop();
  if (render().length > limit && inbox) {
    const excess = render().length - limit;
    inbox = inbox.slice(0, Math.max(0, inbox.length - excess));
  }
  return render().slice(0, limit);
}

export function fleetBriefWithRelease(runs: FleetRuns, releases: unknown, nowMs: number): string {
  const phantom = (name: string) => name === 'phantom' || name.endsWith('/phantom');
  const lines = isOpsReleases(releases)
    ? [...releases.repos].sort((a, b) => Number(phantom(b.repo)) - Number(phantom(a.repo)))
      .map((repo) => `Release: ${repo.repo} ${releaseLine(repo, nowMs)}`)
    : ['Release: status unknown'];
  let text = fleetBriefText(runs, nowMs);
  for (const line of lines) {
    if (text.length + line.length + 1 > limit) break;
    text += `\n${line}`;
  }
  return text;
}
