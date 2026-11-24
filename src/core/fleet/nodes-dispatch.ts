/**
 * core/fleet/nodes-dispatch.ts: hand one planned job to another computer.
 * Backs `phm nodes dispatch <job-id> --node <name> [--dry-run] [--json]`.
 *
 * It decides; a NodeDispatchAdapter touches the other computer. The adapter
 * is the only seam: the default one cannot reach any computer, so every
 * answer is a dry run with the reason. Nothing here copies a login, edits
 * ssh/Tailscale settings or publishes. Branch return and publication are
 * outside this decision seam and are not implemented here.
 * Kill switch: the file `<runs dir>/queue/nodes-dispatch.off` (or ORCH_OFF).
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NodesPlan } from './nodes-plan.js';
import { UNKNOWN } from './runtime-identity.js';

type Unknown = typeof UNKNOWN;
export const NODES_DISPATCH_SCHEMA = 'phantom.nodes-dispatch.v1';
export const NODES_DISPATCH_OFF_FILE = join('queue', 'nodes-dispatch.off');

/** What the other computer says about itself for one lane. Each fact may be unknown. */
export interface NodeProbe { reachable: boolean | Unknown; cliInstalled: boolean | Unknown; signedIn: boolean | Unknown }
export interface NodeStartRequest { job: string; node: string; lane: string; branch: string }
export interface NodeStartResult { started: boolean; why: string }
export interface NodeDispatchAdapter {
  /** Read only. Must not start anything, copy a login or change a setting. */
  probe(node: string, lane: string): Promise<NodeProbe>;
  /** Make a worktree on that computer and run the lane worker. Called only after every check passed. */
  start(request: NodeStartRequest): Promise<NodeStartResult>;
}
/** No remote runner is wired in yet: nothing is known and nothing can start. */
export const planOnlyAdapter: NodeDispatchAdapter = {
  probe: async () => ({ reachable: UNKNOWN, cliInstalled: UNKNOWN, signedIn: UNKNOWN }),
  start: async () => ({ started: false, why: 'no remote runner is connected yet' }),
};

export type DispatchOutcome = 'started' | 'dry-run' | 'refused';
export interface NodeDispatchResult {
  schema: typeof NODES_DISPATCH_SCHEMA;
  job: string;
  node: string;
  lane: string | Unknown;
  accepted: boolean;
  outcome: DispatchOutcome;
  /** One plain sentence. */
  why: string;
  /** What would run, in order. Nothing in it has been done unless outcome is "started". */
  steps: string[];
  kill_switch: string;
}

export interface NodeDispatchDeps {
  readPlan(): Promise<NodesPlan>;
  adapter: NodeDispatchAdapter;
  runsDir: string;
  /** Who this computer is; its own jobs go through the local launcher. */
  self: string;
}

export const defaultRunsDir = (): string => process.env['ASHLR_RUNS_DIR']?.trim() || join(homedir(), '.ashlr-runs');

/** The off switch is present, or its state cannot be read (closed on doubt). */
export function dispatchSwitchedOff(runsDir: string): string | null {
  for (const rel of [NODES_DISPATCH_OFF_FILE, 'ORCH_OFF']) {
    const path = join(runsDir, rel);
    try { lstatSync(path); return path; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return path; }
  }
  return null;
}

const branchFor = (job: string): string => `codex-bridge/${job}`;
const stepsFor = (job: string, node: string, lane: string): string[] => [
  `Check ${node} is reachable and signed in to ${lane}.`,
  `On ${node}: make a worktree for ${branchFor(job)} and run the ${lane} worker there (the same worker command the local launcher runs).`,
  `Branch return and publication are not implemented by this adapter contract.`,
];

export async function dispatchNodeJob(deps: NodeDispatchDeps, req: { job: string; node: string; dryRun: boolean }): Promise<NodeDispatchResult> {
  const { job, node } = req;
  const switchFile = join(deps.runsDir, NODES_DISPATCH_OFF_FILE);
  const make = (lane: string | Unknown, outcome: DispatchOutcome, why: string): NodeDispatchResult =>
    ({ schema: NODES_DISPATCH_SCHEMA, job, node, lane, accepted: outcome === 'started', outcome, why, steps: lane === UNKNOWN ? [] : stepsFor(job, node, lane), kill_switch: switchFile });

  const off = dispatchSwitchedOff(deps.runsDir);
  if (off) return make(UNKNOWN, 'refused', `Remote dispatch is switched off or its switch is unreadable (${off}).`);
  if (node.toLowerCase() === deps.self.toLowerCase()) return make(UNKNOWN, 'refused', `${node} is this computer; the local launcher runs its jobs.`);

  const plan = await deps.readPlan().catch(() => null);
  if (!plan) return make(UNKNOWN, 'refused', 'The plan could not be read, so nothing was handed off.');
  const target = plan.nodes.find(n => n.name.toLowerCase() === node.toLowerCase());
  if (!target) return make(UNKNOWN, 'refused', `${node} is not a known computer. Run \`phm nodes\` to see them.`);
  const slot = plan.assignable.find(a => a.job === job && a.node.toLowerCase() === node.toLowerCase());
  if (!slot) return make(UNKNOWN, 'refused', `${job} is not assignable to ${target.name} now. Run \`phm nodes plan\` to see what fits.`);
  const lane = slot.lane;
  if (!lane?.trim() || lane === UNKNOWN) return make(UNKNOWN, 'refused', 'The assignment lane is unknown; nothing was handed off.');

  const probe = await deps.adapter.probe(target.name, lane).catch((): NodeProbe => ({ reachable: UNKNOWN, cliInstalled: UNKNOWN, signedIn: UNKNOWN }));
  if (probe.reachable !== true) return make(lane, 'dry-run', probe.reachable === false ? `${target.name} is not reachable; showing the plan only.` : `${target.name} could not be checked; showing the plan only.`);
  if (probe.cliInstalled !== true) return make(lane, 'dry-run', probe.cliInstalled === false ? `${target.name} does not have the ${lane} CLI; showing the plan only.` : `Whether ${target.name} has the ${lane} CLI is unknown; showing the plan only.`);
  if (probe.signedIn === false) return make(lane, 'refused', `${target.name} is not signed in to ${lane}.`);
  if (probe.signedIn !== true) return make(lane, 'dry-run', `Whether ${target.name} is signed in to ${lane} is unknown; showing the plan only.`);
  if (req.dryRun) return make(lane, 'dry-run', `Dry run: ${target.name} can take ${job}; nothing was started.`);

  const started = await deps.adapter.start({ job, node: target.name, lane, branch: branchFor(job) }).catch((): NodeStartResult => ({ started: false, why: 'the start request failed' }));
  return started.started ? make(lane, 'started', `${target.name} accepted ${job}.`) : make(lane, 'refused', `${target.name} did not start ${job}: ${started.why}.`);
}
