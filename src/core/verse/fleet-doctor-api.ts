/** GET /api/verse/fleet/doctor: read-only report from the fleet doctor. */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import type { FleetDoctorReport } from '../../cli/fleet-doctor.js';

export function createFleetDoctorApi(run?: () => Promise<FleetDoctorReport>): ApiModule {
  const doctor = run ?? (async () => (await import('../../cli/fleet-doctor.js')).runFleetDoctor());
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/doctor') return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    let report: FleetDoctorReport;
    try {
      report = await doctor();
    } catch {
      report = { v: 1, generatedAt: new Date().toISOString(), level: 'warn',
        checks: [{ name: 'doctor', level: 'warn', reason: 'could not run' }] };
    }
    sendJson(res, 200, report);
    return true;
  };
}

export const handleFleetDoctorApi: ApiModule = createFleetDoctorApi();
