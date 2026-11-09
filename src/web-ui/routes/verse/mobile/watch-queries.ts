import { optionalQuery } from '../command/surface-data.js';
import { summarizePhoneActivity } from '../../../../core/web/phone-activity-summary.js';
import { summarizeWorldForPhone } from '../../../../core/web/phone-world-summary.js';

export const phoneWorldQuery = optionalQuery('phone-watch-world', '/api/verse/world', 'The world model', summarizeWorldForPhone);
export const phoneActivityQuery = optionalQuery('phone-watch-activity', '/api/verse/activity', 'Agent activity', summarizePhoneActivity);

export const PHONE_WORLD_POLL_MS = 15_000;
export const PHONE_ACTIVITY_POLL_MS = 5_000;
