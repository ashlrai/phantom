import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

type Tone = 'ok' | 'warn' | 'bad';

export function plannerRows(runs: FleetRuns | null, _nowMs: number) {
  return (runs?.leaders ?? []).map(({ label, ageSeconds }) => ({
    label,
    ageSeconds,
    ageText: ageSeconds === null ? 'Unknown' : `${ageText(ageSeconds)} ago`,
    tone: (ageSeconds === null || ageSeconds >= 45 * 60 ? 'bad' : ageSeconds >= 20 * 60 ? 'warn' : 'ok') as Tone,
  }));
}

export function plannerTell(runs: FleetRuns | null, nowMs: number): { text: string; tone: Tone } | null {
  if (!runs) return null;
  const stale = plannerRows(runs, nowMs).filter((row) => row.tone !== 'ok');
  const personal = stale.filter((row) => /sol|executor/i.test(row.label));
  const claude = stale.filter((row) => /claude/i.test(row.label));
  const lane = runs.lanes.find((item) => item.lane.toLowerCase() === 'codex-personal');
  const usage = /usage/i.test(lane?.heldReason ?? '');
  const notices: string[] = [];
  const affected: typeof stale = [];
  const passes = (rows: typeof stale) => rows.map((row) => `${row.label} (last pass: ${row.ageText})`).join(', ');
  if (personal.length && lane && (lane.held || usage)) {
    const state = lane.held && usage ? 'held with a usage issue' : lane.held ? 'held' : 'reporting a usage issue';
    notices.push(`The personal Codex lane is ${state}; planner passes: ${passes(personal)}.`);
    affected.push(...personal);
  }
  if (claude.length && /^down/i.test(runs.claudeLane ?? '')) {
    notices.push(`${passes(claude)}: the Claude lane is down. See the fix line in Claude lane.`);
    affected.push(...claude);
  }
  return notices.length ? { text: notices.join(' '), tone: affected.some((row) => row.tone === 'bad') ? 'bad' : 'warn' } : null;
}
