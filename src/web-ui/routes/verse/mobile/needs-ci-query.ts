import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { CiRunFactsV1 } from './needs-ci-model.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Narrow the wire response to the facts the card uses; invalid facts stay unavailable. */
function readCiRunFacts(value: unknown): CiRunFactsV1 | undefined {
  if (!record(value) || value['v'] !== 1 || typeof value['generatedAt'] !== 'string'
    || !(value['repo'] === null || typeof value['repo'] === 'string') || typeof value['available'] !== 'boolean'
    || !record(value['byEvent']) || !count(value['byEvent']['pull_request'])
    || !record(value['failures']) || !count(value['failures']['total'])
    || !count(value['failures']['bindArtifact']) || !count(value['failures']['code'])) return undefined;
  return {
    v: 1, generatedAt: value['generatedAt'], repo: value['repo'], available: value['available'],
    byEvent: { pull_request: value['byEvent']['pull_request'] },
    failures: { total: value['failures']['total'], bindArtifact: value['failures']['bindArtifact'], code: value['failures']['code'] },
  };
}

export const needsCiQuery: QueryDef<CiRunFactsV1 | undefined> = {
  key: 'mobile-fleet-ci-runs',
  async fetch(signal) {
    try {
      return readCiRunFacts(await apiGet<unknown>('/api/verse/fleet/ci-runs?hours=24', signal));
    } catch {
      return undefined;
    }
  },
};
