/** Target collector provenance, separate from provider identity and billing authority. */
import { join } from 'node:path';
import { canonical } from '../universe/artifacts.js';
import { validSubscriptionOnlyBoundary } from '../routing/subscription-only.js';
import { decodeResourcePoolState, type ResourcePoolState } from './pool-runtime.js';
import type { ResourcePool, ResourceObservation, ResourceObservationCommissioning } from './pool-policy.js';
import type { ResourceBinding } from './worker.js';
import type { ResourceQuotaRefreshConfig } from './quota-refresh-config.js';
import { inspectResourceQuotaRefreshOwner } from './quota-refresh-lease.js';
import { readSharedQuotaEvidence } from './quota-shared-evidence.js';
import { assertResourcePoolCommissioningCustody, type ResourceCommissioningFence, commissioningHash as hash, commissioningPresent as present,
  commissioningProfileEpoch, readCommissioningData } from './pool-commissioning-custody.js';

function envelopes(root: string, state: ResourcePoolState, config: ResourceQuotaRefreshConfig,
  fences: Map<string, ResourceCommissioningFence>, workerIds: string[]): Map<string, ResourceObservationCommissioning> {
  const selected = workerIds.filter(id => fences.has(id)); const result = new Map<string, ResourceObservationCommissioning>();
  if (!selected.length) return result;
  const accountsRoot = fences.get(selected[0]!)!.accountsRoot;
  if (canonical(readCommissioningData(join(accountsRoot, 'quota-config.json'), accountsRoot)) !== canonical(config)) throw new Error('Commissioning collector configuration changed');
  const owner = hash(inspectResourceQuotaRefreshOwner(root)); const epochs = new Map<string, string>();
  for (const workerId of selected) {
    const fence = fences.get(workerId)!; const key = canonical([fence.command, fence.provider]);
    const epoch = epochs.get(key) ?? commissioningProfileEpoch(fence.command, fence.provider); epochs.set(key, epoch);
    result.set(workerId, { planDigest: fence.planDigest, poolDigest: state.poolDigest, profileMetadataDigest: fence.profileMetadataDigest,
      profileEpochDigest: epoch, collectorBindingDigest: hash({ root, poolDigest: state.poolDigest, quotaConfigDigest: hash(config), workerId,
        command: fence.command, profileMetadataDigest: fence.profileMetadataDigest }), collectorOwner: owner });
  }
  if (hash(inspectResourceQuotaRefreshOwner(root)) !== owner) throw new Error('Commissioning collector generation changed');
  return result;
}
export function captureResourceCommissioningObservations(root: string, pool: ResourcePool, bindings: ResourceBinding[],
  config: ResourceQuotaRefreshConfig, workerIds: string[]): Map<string, ResourceObservationCommissioning> {
  if (!present(join(root, 'pool-state.json'))) {
    if (present(join(root, 'pool-commissioning'))) throw new Error('Commissioning ledger unavailable'); return new Map();
  }
  const state = decodeResourcePoolState(readCommissioningData(join(root, 'pool-state.json'), root), pool, bindings);
  return envelopes(root, state, config, assertResourcePoolCommissioningCustody(root, state), workerIds);
}
export function captureResourceCommissioningObservation(root: string, pool: ResourcePool, bindings: ResourceBinding[],
  config: ResourceQuotaRefreshConfig, workerId: string): ResourceObservationCommissioning | null {
  return captureResourceCommissioningObservations(root, pool, bindings, config, [workerId]).get(workerId) ?? null;
}
/** Caller lookalikes and imported timestamps cannot qualify: independently match exact active-owned
 * shared evidence, target/config/profile/capture generation and current auth-file metadata epoch. */
export function qualifyResourceCommissioningObservations(root: string, state: ResourcePoolState, pool: ResourcePool, bindings: ResourceBinding[], rows: ResourceObservation[]) {
  const fences = assertResourcePoolCommissioningCustody(root, state);
  if (!fences.size) return { observations: rows, quotaDenied: [] as string[], billingDenied: [] as string[] };
  let config: ResourceQuotaRefreshConfig | null = null;
  let trusted: ReturnType<typeof readSharedQuotaEvidence> | null = null;
  try {
    const accountsRoot = [...fences.values()][0]!.accountsRoot;
    config = readCommissioningData(join(accountsRoot, 'quota-config.json'), accountsRoot) as ResourceQuotaRefreshConfig;
    trusted = readSharedQuotaEvidence({ root, pool, bindings, config });
  } catch { /* Unknown or closed collector cannot attest current commissioned capacity. */ }
  let expected = new Map<string, ResourceObservationCommissioning>();
  try { if (config && trusted) expected = envelopes(root, state, config, fences, rows.map(row => row.workerId)); } catch { trusted = null; }
  const observations: ResourceObservation[] = []; const qualified = new Set<string>(); const billing = new Set<string>();
  for (const row of rows) {
    const fence = fences.get(row.workerId); if (!fence) { observations.push(row); continue; }
    try {
      if (!config || !trusted || !row.commissioning) continue;
      const current = expected.get(row.workerId);
      const { subscriptionOnlyBoundary: _billing, ...envelope } = row.commissioning;
      if (!current || canonical(envelope) !== canonical(current) || row.commissioning.collectorOwner !== trusted.owner ||
        canonical(trusted.observations.find(r => r.workerId === row.workerId)) !== canonical(row)) continue;
      observations.push(row); qualified.add(row.workerId);
      const boundary = row.commissioning.subscriptionOnlyBoundary;
      const pin = config.workers.find(w => w.workerId === row.workerId)?.accountHint;
      if (validSubscriptionOnlyBoundary(boundary) && boundary.accountHint === pin && boundary.observedAt === row.observedAt &&
        Date.parse(boundary.observedAt) <= Date.now() && Date.parse(boundary.expiresAt) > Date.now() &&
        (fence.provider === 'codex' && boundary.source === 'codex-siwc-app-credit-control' || fence.provider === 'claude' && boundary.source === 'claude-native-extra-usage')) billing.add(row.workerId);
    } catch { /* A profile or collector changed after capture; recollect, never carry old proof. */ }
  }
  return { observations, quotaDenied: [...fences.keys()].filter(id => !qualified.has(id)), billingDenied: [...fences.keys()].filter(id => !billing.has(id)) };
}
