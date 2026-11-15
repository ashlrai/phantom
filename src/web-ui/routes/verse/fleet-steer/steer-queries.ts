import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { parseSteerSnapshot, WB_STEER_READ_PATH, type SteerSnapshot } from './steer-model.js';

export const steerQuery: QueryDef<SteerSnapshot> = {
  key: 'wb-steer',
  fetch: async (signal) => parseSteerSnapshot(await apiGet<unknown>(WB_STEER_READ_PATH, signal), Date.now()),
};
