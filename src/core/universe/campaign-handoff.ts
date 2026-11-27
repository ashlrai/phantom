/** Read-only exact campaign delivery proof for successor enrollment. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory, isSha256Hex, isUniverseId } from './artifacts.js';
import { isCanonicalAbsolutePath } from './input-guards.js';
import { readUniverseCampaign } from './campaign-store.js';
import { validateUniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import { readCompletedCampaignDeliveryProjection } from './campaign-delivery-recovery.js';
import { assertComparatorUnchanged, manifestRecord, universePath } from './store.js';
import type { UniverseCampaignDeliveryOrigin, UniverseCampaignDeliverySource } from './campaign-handoff-types.js';
export type { UniverseCampaignDeliveryOrigin, UniverseCampaignDeliverySource } from './campaign-handoff-types.js';

export function validateUniverseCampaignDeliverySource(input: unknown): UniverseCampaignDeliverySource {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > 16 * 1024) throw new Error('Invalid campaign delivery source');
  const value = JSON.parse(text) as UniverseCampaignDeliverySource;
  const keys = ['root', 'campaignId', 'expectedDefinitionDigest', 'expectedManifestDigest', 'expectedComparatorDigest', 'delivery', 'expectedDeliveryDigest'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key)) || !isCanonicalAbsolutePath(value.root, { allowRoot: true }) ||
      !isUniverseId(value.campaignId) ||
      ![value.expectedDefinitionDigest, value.expectedManifestDigest, value.expectedComparatorDigest, value.expectedDeliveryDigest]
        .every(isSha256Hex)) throw new Error('Invalid campaign delivery source');
  // The shared closed target codec preserves explicit initial-repair policy.
  if (!value.delivery || typeof value.delivery !== 'object' || Array.isArray(value.delivery) ||
      Object.keys(value.delivery).some(key => !['branch', 'baseCommit', 'allowInitialRepair'].includes(key))) throw new Error('Invalid campaign delivery target');
  const { campaignId: _campaignId, ...delivery } = validateUniverseCampaignDeliveryPlan({ schemaVersion: 1,
    deliveries: [{ ...value.delivery, campaignId: value.campaignId }] }, [value.campaignId]).deliveries[0]!;
  return { ...value, delivery };
}

export function readUniverseCampaignDeliverySource(input: unknown, requestDigest: string): UniverseCampaignDeliveryOrigin {
  const source = validateUniverseCampaignDeliverySource(input);
  if (!isSha256Hex(requestDigest)) throw new Error('Invalid campaign successor request digest');
  const root = inspectPrivateDirectory(source.root);
  const campaign = readUniverseCampaign(source.campaignId, { root });
  if (campaign.sourceState !== 'healthy' || campaign.state !== 'completed' || campaign.definitionDigest !== source.expectedDefinitionDigest ||
      campaign.manifestDigest !== source.expectedManifestDigest || campaign.comparatorDigest !== source.expectedComparatorDigest) {
    throw new Error('Campaign successor source identity changed');
  }
  const directory = universePath(root, campaign.definition.universeId);
  const record = manifestRecord(directory);
  assertComparatorUnchanged(record);
  // The independently fresh receipt read supplies this observation's Universe.
  // Historical recovery remains receipt-only; successor admission still requires idleness.
  const projection = readCompletedCampaignDeliveryProjection(campaign, source.delivery, { root });
  if (!projection) throw new Error('Campaign successor delivery is unavailable or changed');
  const { receipt, universe } = projection;
  if (universe.sourceState !== 'healthy' || universe.activeRun || record.manifestDigest !== campaign.manifestDigest ||
      record.comparatorDigest !== campaign.comparatorDigest) throw new Error('Campaign successor source is not healthy and idle');
  if (digest(canonical(receipt)) !== source.expectedDeliveryDigest) throw new Error('Campaign successor delivery is unavailable or changed');
  return { schemaVersion: 1, requestDigest, sourceRootDigest: digest(canonical({ domain: 'campaign-source-root-v1', root })),
    campaignId: source.campaignId, universeId: campaign.definition.universeId, definitionDigest: campaign.definitionDigest,
    manifestDigest: campaign.manifestDigest, comparatorDigest: campaign.comparatorDigest, deliveryDigest: source.expectedDeliveryDigest,
    deliveryId: receipt.id, runId: receipt.runId, trialId: receipt.trialId, repo: receipt.repo, commit: receipt.commit,
    tree: receipt.tree, artifactDigest: receipt.artifactDigest };
}
