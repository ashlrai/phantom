/**
 * `ashlr fleet autopilot-state [--repo <owner/name>]... [--json]` — one
 * bounded read-only assembly of the fleet autopilot inputs recovered from
 * open PR #4071 (RQ-SWE3-AUTOPILOT-1): queue/status.json admission,
 * queue/ready.tsv supply, queue/slots.json lane targets and, per --repo, the
 * read-only `gh pr list` rebase-coverage read. Prints the state as JSON or a
 * concise per-source summary. Never mutates: no writes, no dispatch, no
 * merges — the state is advisory input for a later planner. See
 * src/core/fleet/autopilot-state.ts.
 *
 * Exported as a promise-returning function rather than `async function` on
 * purpose: scripts/gen-fleet-registry.mjs only registers async exports, and
 * this recovery slice may not touch the generated registry. The convention
 * dispatcher awaits the returned promise either way; wiring the verb into
 * FLEET_SUBCOMMAND_LOADERS is a one-line generated follow-up.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readFleetAutopilotState, type FleetAutopilotState } from '../core/fleet/autopilot-state.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: ashlr fleet autopilot-state [--json] [--runs-dir <abs>] [--repo <owner/name>]...
Read-only assembly of fleet autopilot state: admission (queue/status.json), ready/parked supply (queue/ready.tsv + metrics/jobs.jsonl), lane targets (queue/slots.json), and optional per-repo conflicting-PR rebase coverage. --repo may repeat across distinct repo names; without it the rebase source reports 'unconfigured'.
Prints JSON with --json or a per-source summary otherwise. Exits 1 when no local source is readable, 2 on bad arguments. Never writes, dispatches or merges.`;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface FleetAutopilotStateDeps {
  /** State assembly seam; tests inject a fixed FleetAutopilotState. */
  loadState?: (opts: { runsDir: string; repos: string[] }) => Promise<FleetAutopilotState>;
}

/** True when at least one local source produced usable state. */
function stateReadable(state: FleetAutopilotState): boolean {
  return state.admission !== null || state.sources.queue === 'healthy' || state.sources.slots === 'healthy';
}

/** Plain, no-color per-source render of the state for humans. */
export function formatAutopilotState(state: FleetAutopilotState): string {
  const lines: string[] = [`fleet autopilot-state — generated ${state.generatedAt}`];
  lines.push(`  status: ${state.sources.status}${state.admission ? ` (cap ${state.admission.global.cap}, running ${state.admission.global.running}${state.admission.global.at_cap ? ', at cap' : ''})` : ''}`);
  if (state.queue) {
    lines.push(`  queue: ${state.sources.queue} (ready ${state.queue.ready}, parked ${state.queue.parked}, ${state.queue.byLane.length} lanes, unmet dep rows ${state.queue.unmetDeps?.length ?? 0})`);
  } else {
    lines.push(`  queue: ${state.sources.queue}`);
  }
  lines.push(`  slots: ${state.sources.slots}${state.slots ? ` (${state.slots.lanes.length} lane targets)` : ''}`);
  if (state.rebase === null) {
    lines.push(`  rebase: ${state.sources.rebase}`);
  } else {
    const due = state.rebase.reduce((sum, row) => sum + (row.uncovered ?? 0) + (row.staleHeadOnly ?? 0), 0);
    lines.push(`  rebase: ${state.sources.rebase} (${state.rebase.length} repos, ${due} conflicting PRs due a rebase)`);
    for (const row of state.rebase) {
      lines.push(`    ${row.repo}: ${row.source}, conflicting ${row.conflicting ?? '?'}, uncovered ${row.uncovered ?? '?'}, stale-head ${row.staleHeadOnly ?? '?'}`);
    }
  }
  return lines.join('\n');
}

export function cmdFleetAutopilotState(args: string[], deps: FleetAutopilotStateDeps = {}): Promise<number> {
  return runAutopilotState(args, deps);
}

async function runAutopilotState(args: string[], deps: FleetAutopilotStateDeps): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  let json = false;
  let runsDir: string | undefined;
  const repos: string[] = [];
  const repoNames = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && isAbsolute(args[i + 1] ?? '')) runsDir = args[++i]!;
    else if (arg === '--repo' && REPO.test(args[i + 1] ?? '') && !repoNames.has(args[i + 1]!.split('/')[1]!.toLowerCase())) {
      repoNames.add(args[++i]!.split('/')[1]!.toLowerCase());
      repos.push(args[i]!);
    }
    else { console.error(USAGE); return 2; }
  }
  const state = sanitizePublicJson(await (deps.loadState ?? ((o) => readFleetAutopilotState(o)))({
    runsDir: runsDir ?? join(homedir(), '.ashlr-runs'), repos,
  })) as FleetAutopilotState;
  console.log(json ? JSON.stringify(state) : formatAutopilotState(state));
  if (!stateReadable(state)) {
    console.error('fleet autopilot-state: no usable local source — status.json, ready.tsv and slots.json are all missing or unreadable');
    return 1;
  }
  return 0;
}
