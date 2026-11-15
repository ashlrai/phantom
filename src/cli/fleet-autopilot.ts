/**
 * `phm fleet autopilot --once --json` — one bounded read-only planning cycle
 * (RQ-SWE3-AUTOPILOT-1), the seed of the leader-as-CEO loop. Reads
 * queue/slots/admission state under ~/.ashlr-runs, computes lane utilization
 * against targets, identifies the single highest-leverage gap (uncovered
 * conflicting PRs, a starved lane, stale parked deps, or missing restock)
 * and emits one proposed action: enqueue N jobs of a type, hold a lane, or
 * no-op. Never mutates: no writes, no dispatch, no merges — the proposal is
 * advisory. See src/core/fleet/autopilot.ts.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { planFleetAutopilot, readFleetAutopilotState, type AutopilotReport, type FleetAutopilotState } from '../core/fleet/autopilot.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm fleet autopilot [--once] [--json] [--runs-dir <abs>] [--repo <owner/name>]...
One bounded read-only planning cycle: reads queue/slots/admission state, computes lane utilization vs targets, picks the single highest-leverage gap and emits one proposed action (enqueue | hold-lane | no-op). Never mutates.
--once marks a single cycle (the only mode today). --repo may repeat across distinct repo names to include the read-only \`gh pr list\` uncovered-conflicting-PR read; without it that gap class is unmeasured.`;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface FleetAutopilotDeps {
  /** State assembly seam; tests inject a fixed FleetAutopilotState. */
  loadState?: (opts: { runsDir: string; repos: string[] }) => Promise<FleetAutopilotState>;
}

/** Plain, no-color render of the report for humans. */
export function formatAutopilotReport(report: AutopilotReport): string {
  const lines: string[] = [];
  const global = report.global;
  const capText = global.cap === null ? 'cap unknown' : `running ${global.running ?? '?'} of cap ${global.cap}${global.atCap ? ' (at cap)' : ''}`;
  lines.push(`Autopilot ${report.status} — ${capText}${global.admitReason ? `, admit: ${global.admitReason}` : ''}`);
  for (const lane of report.lanes) {
    const util = lane.utilization === null ? '—' : `${Math.round(lane.utilization * 100)}%`;
    const bits = [
      `running ${lane.running ?? '?'}/${lane.target ?? '?'}`,
      `queued ${lane.queued ?? '?'}`,
      lane.ready !== null ? `ready ${lane.ready}` : null,
      lane.parked ? `parked ${lane.parked}` : null,
      lane.depWaiting ? `dep-waiting ${lane.depWaiting}` : null,
      lane.freeSlots !== null && lane.freeSlots > 0 ? `free ${lane.freeSlots}` : null,
      lane.held ? 'HELD' : null,
      lane.reason && lane.reason !== 'ok' ? lane.reason : null,
    ].filter(Boolean).join(', ');
    lines.push(`  ${lane.lane}: ${bits} (util ${util})`);
  }
  for (const gap of report.gaps) lines.push(`  gap[${gap.kind}${gap.lane ? ` ${gap.lane}` : ''}] sev ${gap.severity}: ${gap.detail}`);
  const a = report.action;
  lines.push(a.kind === 'enqueue'
    ? `action: enqueue ${a.count} ${a.type} job${a.count === 1 ? '' : 's'}${a.lane ? ` for '${a.lane}'` : ''}${a.repos?.length ? ` (${a.repos.join(', ')})` : ''} — ${a.detail}`
    : a.kind === 'hold-lane'
      ? `action: hold lane '${a.lane}' — ${a.detail}`
      : `action: no-op (${a.reason}) — ${a.detail}`);
  return lines.join('\n');
}

export async function cmdFleetAutopilot(args: string[], deps: FleetAutopilotDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  let json = false;
  let once = false;
  let runsDir: string | undefined;
  const repos: string[] = [];
  const repoNames = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--once' && !once) once = true;
    else if (arg === '--runs-dir' && runsDir === undefined && isAbsolute(args[i + 1] ?? '')) runsDir = args[++i]!;
    else if (arg === '--repo' && REPO.test(args[i + 1] ?? '') && !repoNames.has(args[i + 1]!.split('/')[1]!.toLowerCase())) {
      repoNames.add(args[++i]!.split('/')[1]!.toLowerCase());
      repos.push(args[i]!);
    }
    else { console.error(USAGE); return 2; }
  }
  const state = await (deps.loadState ?? ((o) => readFleetAutopilotState(o)))({ runsDir: runsDir ?? join(homedir(), '.ashlr-runs'), repos });
  const report = sanitizePublicJson(planFleetAutopilot(state)) as AutopilotReport;
  console.log(json ? JSON.stringify(report) : formatAutopilotReport(report));
  return 0;
}
