/** Read-only usage journal projection. No repair or dispatch authority. */
import { auditUsageMotion, type UsageMotionAuditOptions, type UsageMotionAuditView } from '../fleet/usage-motion-audit.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_USAGE_AUDIT_PATH = '/api/verse/fleet/usage-audit';
export interface FleetUsageAuditResponseV1 {
  v: 1;
  generatedAt: string;
  audit: UsageMotionAuditView;
}
export interface FleetUsageAuditApiDeps {
  audit?: (options: UsageMotionAuditOptions) => Promise<UsageMotionAuditView>;
}

export function createFleetUsageAuditApi(deps: FleetUsageAuditApiDeps = {}): ApiModule {
  const audit = deps.audit ?? auditUsageMotion;
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_USAGE_AUDIT_PATH || method !== 'GET') return false;
    const options: UsageMotionAuditOptions = {};
    try {
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      for (const [key, value] of params) {
        const bounds = key === 'windowMinutes' ? [15, 360] : key === 'freshnessMinutes' ? [5, 120] : null;
        if (!bounds || params.getAll(key).length !== 1 || !/^\d+$/.test(value)
          || Number(value) < bounds[0]! || Number(value) > bounds[1]!) throw new Error('invalid');
        options[key as 'windowMinutes' | 'freshnessMinutes'] = Number(value);
      }
    } catch {
      sendJson(res, 400, { v: 1, error: 'Invalid query.' });
      return true;
    }
    try {
      const view = await audit(options);
      const body: FleetUsageAuditResponseV1 = { v: 1, generatedAt: view.generatedAt, audit: view };
      sendJson(res, 200, body);
    } catch {
      sendJson(res, 503, { v: 1, error: 'usage audit unavailable' });
    }
    return true;
  };
}
export const handleFleetUsageAuditApi: ApiModule = createFleetUsageAuditApi();
