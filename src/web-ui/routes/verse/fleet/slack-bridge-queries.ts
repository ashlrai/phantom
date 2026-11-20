import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowSlackBridge, type SlackBridgeView } from './slack-bridge-model.js';

const PATH = '/api/fleet/slack-bridge';
let missing: ApiError | undefined;
export const slackBridgeQuery: QueryDef<SlackBridgeView> = { key: 'verse-fleet-slack-bridge', async fetch(signal) {
  if (missing) throw missing;
  try {
    const value = narrowSlackBridge(await apiGet<unknown>(PATH, signal));
    if (value === null) throw new Error('Invalid Slack bridge response');
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) missing = error;
    throw error;
  }
} };
