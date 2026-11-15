/** Metadata-only learning projection. Never grants authority or changes routing. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import type { AshlrConfig, Proposal } from '../types.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { loadBanditStats, parseLocalFirstBanditConfig, recordMergeOutcome, readMergeOutcomes, type BanditStats } from '../routing/local-first-bandit.js';
import { readRoutingLedger } from '../routing/routing-ledger.js';
import { listFleetMergeStateKeys, proposalStateKey, readFleetMergeState } from './fleet-merge-state.js';
import { scrubSecrets } from '../util/scrub.js';

function configOf(cfg: AshlrConfig) {
  return parseLocalFirstBanditConfig((cfg as unknown as Record<string, unknown>)['localFirstBandit']);
}

export interface BanditStatus {
  enabled: boolean;
  reason: 'disabled' | 'cold-start-p4' | 'ready';
  stats: BanditStats;
}

/** Read-only, value-free status; readiness never implies permission to use a lane. */
export function banditStatus(cfg: AshlrConfig): BanditStatus {
  const config = configOf(cfg);
  const stats = loadBanditStats();
  return {
    enabled: config.enabled,
    reason: !config.enabled ? 'disabled'
      : stats.local.pulls < config.minSamplesPerArm || stats.frontier.pulls < config.minSamplesPerArm
        ? 'cold-start-p4' : 'ready',
    stats,
  };
}

/** Read only numeric usage from the run ledger; never pass run content onward. */
function runCost(runId: string): number | null {
  const root = join(homedir(), '.ashlr');
  for (const store of ['runs', 'swarms']) {
    const read = readStableRegularFile(join(root, store, `${runId}.json`), {
      anchorPath: root, maxFileBytes: 64 * 1024 * 1024, remainingBytes: 64 * 1024 * 1024,
    });
    if (!read.ok) continue;
    const run = JSON.parse(read.text) as { id?: unknown; usage?: { estCostUsd?: unknown } };
    const cost = run?.usage?.estCostUsd;
    if (run?.id !== runId || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
    return cost;
  }
  return null;
}

/**
 * Called only after a proposal status commits. Generic applied/rejected states
 * are not PR evidence: require a fleet PR plus its terminal state or the exact
 * merge-pass transition reason (the pass persists its state after setStatus).
 * Errors and missing joins produce no evidence, never a synthetic free run.
 */
export function recordProposalBanditOutcome(proposal: Proposal, nowMs = Date.now()): void {
  try {
    if (!configOf(loadConfigReadOnlyStrict()).enabled) return;
    const itemId = proposal.workItemId;
    if (!itemId || itemId.length > 240 || Array.from(itemId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || scrubSecrets(itemId) !== itemId) return;
    const route = readRoutingLedger()?.entries.find(entry => entry.itemId === itemId);
    if (!route || (route.engineClass !== 'local' && route.engineClass !== 'frontier')) return;
    const key = proposalStateKey(proposal.id);
    if (!key) return;
    const state = readFleetMergeState(key);
    if (state?.state !== 'ok' || !state.record.pr || state.record.proposalId !== proposal.id) return;
    const pr = state.record.pr;
    const reason = proposal.decisionReason;
    const merged = pr.state === 'merged' || (proposal.status === 'applied' && (
      reason === 'fleet host merge (standing grant)' || reason === 'merged outside the fleet'));
    const closed = pr.state === 'closed' || (proposal.status === 'rejected' && reason === 'fleet PR closed on GitHub');
    if (!merged && !closed) return;
    if (!proposal.runId || !/^[a-zA-Z0-9_.-]{1,240}$/.test(proposal.runId)) return;
    const costUsd = runCost(proposal.runId);
    if (costUsd === null) return;
    if (readMergeOutcomes().some(outcome => outcome.itemId === itemId)) return;
    const landing = state.record.landing;
    const startMs = Date.parse(route.at);
    const endMs = merged && landing ? Date.parse(landing.landedAt)
      : pr.state === 'merged' || pr.state === 'closed' ? Date.parse(state.record.updatedAt) : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    recordMergeOutcome({ itemId, merged, costUsd, wallMs: endMs - startMs });
  } catch { /* learning must never block proposal completion */ }
}

/**
 * Recovery during the existing pre-selection feedback sweep. Covers PRs closed
 * after an earlier inbox decision, plus crashes between PR state and projection.
 * Uses persisted finish timestamps so a later sweep never adds waiting time.
 */
export async function reconcileBanditOutcomes(): Promise<void> {
  try {
    if (!configOf(loadConfigReadOnlyStrict()).enabled) return;
    const { loadProposal } = await import('../inbox/store.js');
    for (const key of listFleetMergeStateKeys() ?? []) {
      const read = readFleetMergeState(key);
      if (read.state !== 'ok' || !read.record.proposalId ||
        (read.record.pr?.state !== 'merged' && read.record.pr?.state !== 'closed')) continue;
      const proposal = loadProposal(read.record.proposalId);
      if (proposal) recordProposalBanditOutcome(proposal);
    }
  } catch { /* retry the projection on the next sweep */ }
}
