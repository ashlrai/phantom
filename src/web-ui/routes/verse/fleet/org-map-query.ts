import type { FleetOrgMap } from '../../../../core/fleet/org-map.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetOrgMapQuery: QueryDef<FleetOrgMap> = {
  key: 'fleet-org-map',
  fetch: async signal => {
    const value = await apiGet<FleetOrgMap>('/api/verse/fleet/control/map', signal);
    if (value?.schema !== 'fleet.map.v2' || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !value.sources ||
      !value.nodes.every(node => node && ['id', 'label', 'provider', 'status'].every(key => typeof node[key as keyof typeof node] === 'string') && ['leader', 'lane', 'job', 'guardian', 'channel'].includes(node.kind)) ||
      !value.edges.every(edge => edge && ['reports-to', 'message'].includes(edge.kind) && typeof edge.id === 'string' && typeof edge.provider === 'string' && typeof edge.from === 'string' && typeof edge.to === 'string')) throw new Error('Unsupported fleet map');
    return value;
  },
};
