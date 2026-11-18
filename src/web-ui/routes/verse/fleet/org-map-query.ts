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
    // An older server sends no tree, and a tree this build cannot read is dropped: the view then derives one from the graph.
    if (value.tree?.schema !== 'fleet.org.v1' || value.tree.version !== 1 || !Array.isArray(value.tree.lanes) || !value.tree.leader?.dispatcher || !value.tree.sources) delete value.tree;
    return value;
  },
};
