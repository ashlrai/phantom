import { optionalQuery } from '../command/surface-data.js';
import { narrowLeaderOffice } from './leader-office-model.js';

export const leaderOfficeQuery = optionalQuery(
  'verse-leader-office',
  '/api/verse/leader/office',
  'The leader office',
  narrowLeaderOffice,
);
