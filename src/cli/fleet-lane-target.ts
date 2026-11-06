/** `ashlr fleet lane-target` — agent-native lane worker targets. Reads and
 * writes <runsDir>/queue/slots.json through the same core the desktop Capacity
 * view and phone LaneTargetSheet use, so a Sol leader, planner pass or
 * reset-release operator can see and set per-lane targets without a UI.
 * Writes go through setLaneTarget: bounds enforced by the core, temp+rename
 * persistence and a lane-target-changes.log audit line per change. */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty, pad } from './ui.js';
import {
  LaneTargetError,
  readLaneTargets,
  setLaneTarget,
  type LaneTargetsV1,
} from '../core/fleet/runs-lane-targets.js';

const { red } = makeColors(isTty());
const USAGE = 'usage: ashlr fleet lane-target [<lane> [<target>]] [--reason <text>] [--json] [--runs-dir <abs>]';
const CHANGED_BY = 'ashlr fleet lane-target';

const ago = (iso: string | null, nowMs: number): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const m = Math.floor(Math.max(0, nowMs - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

/** Pure, no-color render — unit-testable without I/O. */
export function formatLaneTargets(snapshot: LaneTargetsV1, nowMs = Date.now()): string {
  const lines = [`Lane targets — slots.json ${snapshot.sourceState} · generated ${ago(snapshot.generatedAt, nowMs) || snapshot.generatedAt}`, ''];
  const heldCell = (row: LaneTargetsV1['lanes'][number]): string => !row.held
    ? (row.pausedFrom !== null ? `target was ${row.pausedFrom}` : '—')
    : `held${row.heldReason ? `: ${row.heldReason}` : ''}${row.heldUntil ? ` until ${row.heldUntil}` : ''}` +
      `${row.pausedFrom !== null ? ` · target was ${row.pausedFrom}` : ''}`;
  const L = Math.max(4, ...snapshot.lanes.map(l => l.lane.length));
  const B = Math.max(13, ...snapshot.lanes.map(l => `${l.floor}..${l.ceiling}`.length));
  const H = Math.max(4, ...snapshot.lanes.map(l => heldCell(l).length));
  lines.push(`  ${pad('lane', L)} ${pad('target', 6)} ${pad('floor..ceiling', B)} ${pad('held', H)} last change`);
  lines.push(`  ${'─'.repeat(L + B + H + 24)}`);
  if (snapshot.lanes.length === 0) lines.push('  (no lanes — queue/slots.json is missing or empty)');
  for (const row of snapshot.lanes) {
    const change = [ago(row.lastChange, nowMs), row.changedBy].filter(v => v).join(' · ') || '—';
    lines.push(`  ${pad(row.lane, L)} ${pad(String(row.target), 6)} ${pad(`${row.floor}..${row.ceiling}`, B)} ${pad(heldCell(row), H)} ${change}`);
  }
  if (snapshot.sourceState !== 'healthy') lines.push('', `  source degraded: slots.json reads as "${snapshot.sourceState}" — targets shown may be incomplete.`);
  return lines.join('\n');
}

export async function cmdFleetLaneTarget(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`${USAGE}\n  no args: table every lane's target, bounds, hold and last change (read-only).\n  <lane>: print that lane's row. <lane> <target>: set the target; bounds are\n  enforced by the core, a held lane keeps its hold and the target applies when it lifts.`);
    return 0;
  }
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--runs-dir', '--reason'] });
  if (bad) {
    process.stderr.write(red('error: ') + `fleet lane-target: ${bad.message}\n${USAGE}\n`);
    return 2;
  }
  let json = false;
  let runsDir: string | undefined;
  let reason: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir') runsDir = args[++i];
    else if (arg === '--reason') reason = args[++i];
    else positional.push(arg);
  }
  if (runsDir !== undefined && !isAbsolute(runsDir)) {
    process.stderr.write(red('error: ') + `fleet lane-target: --runs-dir requires an absolute path\n${USAGE}\n`);
    return 2;
  }
  if (positional.length > 2) {
    process.stderr.write(red('error: ') + `fleet lane-target: expected at most <lane> <target>, got ${positional.length} arguments\n${USAGE}\n`);
    return 2;
  }
  if (reason !== undefined && positional.length < 2) {
    process.stderr.write(red('error: ') + `fleet lane-target: --reason only applies when setting a target\n${USAGE}\n`);
    return 2;
  }
  const [lane, targetArg] = positional;
  const snapshot = await readLaneTargets({ runsDir });
  if (lane === undefined) {
    console.log(json ? JSON.stringify(snapshot) : formatLaneTargets(snapshot));
    return 0;
  }
  const row = snapshot.lanes.find(l => l.lane === lane);
  if (targetArg === undefined) {
    if (!row) {
      process.stderr.write(red('error: ') + `fleet lane-target: lane-unknown: ${lane}` +
        `${snapshot.sourceState === 'healthy' ? '' : ` (slots.json ${snapshot.sourceState})`}\n`);
      return 1;
    }
    console.log(json ? JSON.stringify(snapshot) : formatLaneTargets({ ...snapshot, lanes: [row] }));
    return 0;
  }
  if (!/^\d+$/.test(targetArg)) {
    process.stderr.write(red('error: ') + `fleet lane-target: invalid-target: expected a non-negative integer, got: ${targetArg}\n${USAGE}\n`);
    return 2;
  }
  try {
    const next = await setLaneTarget(lane, Number(targetArg), {
      runsDir,
      changedBy: reason ? `${CHANGED_BY}: ${reason}` : CHANGED_BY,
    });
    if (json) {
      console.log(JSON.stringify(next));
      return 0;
    }
    const updated = next.lanes.find(l => l.lane === lane);
    console.log(`${lane}: ${row?.target ?? '?'} -> ${updated?.target ?? targetArg} (ceiling ${updated?.ceiling ?? '?'})` +
      `${updated?.held ? `\nheld: ${updated.heldReason ?? 'no reason recorded'}${updated.heldUntil ? ` until ${updated.heldUntil}` : ''}; the target applies when the hold lifts` : ''}`);
    return 0;
  } catch (error) {
    if (error instanceof LaneTargetError) {
      process.stderr.write(red('error: ') + `fleet lane-target: ${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write(red('error: ') + `fleet lane-target: unavailable: ${(error as Error).message}\n`);
    }
    return 1;
  }
}
