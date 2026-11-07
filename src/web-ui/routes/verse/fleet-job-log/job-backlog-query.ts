import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const actions = ['merge', 'recut', 'refresh', 'wait', 'none'];
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function jobBacklogQuery(repo: string): QueryDef<MergeBacklogReadV1 | null> {
  return {
    key: `verse-job-backlog:${repo}`,
    async fetch(signal) {
      if (!REPO.test(repo)) return null;
      try {
        const value = await apiGet<unknown>(`/api/verse/github/fleet-backlog?repo=${encodeURIComponent(repo)}`, signal);
        if (!object(value) || value.v !== 1 || (typeof value.repo !== 'string' || value.repo.toLowerCase() !== repo.toLowerCase()) || typeof value.generatedAt !== 'string' ||
          !['ok', 'gh-failed'].includes(String(value.source)) || !object(value.counts) || !object(value.counts.mergeState) ||
          !object(value.counts.actions) || !Array.isArray(value.items) || !value.items.every(item => object(item) &&
            Number.isSafeInteger(item.number) && Number(item.number) > 0 && typeof item.mergeStateStatus === 'string' &&
            typeof item.suggestedAction === 'string' && actions.includes(item.suggestedAction) &&
            typeof item.title === 'string' && typeof item.headRef === 'string' &&
            (item.updatedAt === null || typeof item.updatedAt === 'string') && typeof item.isDraft === 'boolean' &&
            (item.job === null || typeof item.job === 'string') && object(item.classification) &&
            typeof item.classification.class === 'string' && typeof item.classification.work === 'string' && typeof item.classification.reason === 'string')) return null;
        return value as unknown as MergeBacklogReadV1;
      } catch (error) {
        // The endpoint sends a 503 for gh-failed; apiGet does not expose its body.
        if (error instanceof ApiError && error.status === 503) return null;
        throw error;
      }
    },
  };
}
