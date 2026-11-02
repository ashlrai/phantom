import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isOperatorGlance, type OperatorGlance } from '../../../../core/fleet/operator-glance.js';

export const operatorGlanceQuery: QueryDef<OperatorGlance | null> = {
  key: 'operator-glance',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs/glance', signal);
      return isOperatorGlance(value) ? value : null;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return null;
      throw error;
    }
  },
};
