/**
 * The Models board's reads and its one action. Each read is the JSON a CLI command prints:
 * `phm models --json` (registry), `phm models check --json` (check), `phm models verify <id> --source <url>` (verify).
 */
import type { ModelCheckReport } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryList, ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const MODELS_PATH = '/api/verse/fleet/control/models';

/** Another shape (an older server, a wrong route) is unreadable, not an empty registry. */
export const modelRegistryQuery: QueryDef<ModelRegistryList> = {
  key: 'verse-model-registry',
  fetch: async signal => {
    const list = await apiGet<ModelRegistryList>(MODELS_PATH, signal);
    if (!list || list.schema !== 'models.registry.v1' || !Array.isArray(list.entries)) throw new Error('unexpected model registry');
    return list;
  },
};

/** Another shape is unreadable, not "all confirmed". */
export const modelCheckQuery: QueryDef<ModelCheckReport> = {
  key: 'verse-model-check',
  fetch: async signal => {
    const report = await apiGet<ModelCheckReport>(`${MODELS_PATH}/check`, signal);
    if (!report || report.schema !== 'models.check.v1' || report.version !== 1 || !Array.isArray(report.models) || !Array.isArray(report.missing)) throw new Error('unexpected model check');
    return report;
  },
};

export async function postVerifyModel(id: string, source: string): Promise<ModelRegistryRow> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token to verify models.');
  const row = await apiPost<ModelRegistryRow>(`${MODELS_PATH}/verify`, { id, source }, token);
  touchMutationHold();
  return row;
}
