import { narrowReleaseLag } from '../../../../core/release/lag-shape.js';
import { optionalQuery } from '../command/surface-data.js';

/** The Fleet header's release line: the same JSON as `phm release lag --json`. */
export const releaseLagQuery = optionalQuery('verse-release-lag', '/api/verse/fleet/release-lag', 'The release check', narrowReleaseLag);
