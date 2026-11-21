/**
 * The Models board's reads and its one action. Each read is the JSON a CLI command prints:
 * `phm models --json` (registry), `phm models check --json` (check), `phm models verify <id> --source <url>` (verify),
 * and `phm throughput --by model --json` (the work each model did in the window).
 */
import type { ModelCheckReport } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryList, ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { WorkWindow } from './model-work-model.js';

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

/** A server that predates `by=model` refuses the grouping; that and any other shape is unreadable, never "no work". */
const workQuery = (hours: WorkWindow): QueryDef<ThroughputReport> => ({
  key: `fleet-throughput-${hours}-model`,
  fetch: async signal => {
    const report = await apiGet<ThroughputReport>(`/api/verse/fleet/runs/throughput?hours=${hours}&by=model`, signal);
    if (!report || report.schema !== 'throughput.v1' || report.by !== 'model' || !Array.isArray(report.groups)) throw new Error('unexpected throughput report');
    return report;
  },
});
// One stable definition per window, so switching back reuses the last reading while it refreshes.
export const MODEL_WORK_QUERIES: Readonly<Record<WorkWindow, QueryDef<ThroughputReport>>> = { 24: workQuery('24'), 168: workQuery('168') };

export async function postVerifyModel(id: string, source: string): Promise<ModelRegistryRow> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token to verify models.');
  const row = await apiPost<ModelRegistryRow>(`${MODELS_PATH}/verify`, { id, source }, token);
  touchMutationHold();
  return row;
}
