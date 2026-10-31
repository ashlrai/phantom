import { describe, expect, it } from 'vitest';
import { decideReload, type UpdateReloadReading } from './update-reload-model.js';

const first: UpdateReloadReading = { installedVersion: '1', headSha: 'old', sourceState: 'healthy' };
const current: UpdateReloadReading = { installedVersion: '2', headSha: 'new', sourceState: 'healthy' };

describe('chunk failure reload decision', () => {
  it('wins over both status triggers and a dismissed sha', () => {
    expect(decideReload({ first, current, appVersion: '1', dismissedSha: 'new', chunkError: true }))
      .toEqual({ show: true, reason: 'chunk-missing', sha: null,
        message: 'Phantom updated while this window was open — reload to finish' });
  });

  it('shows even without a status reading', () => {
    expect(decideReload({ first: null, current: null, appVersion: '1', dismissedSha: null, chunkError: true }))
      .toMatchObject({ show: true, reason: 'chunk-missing' });
  });
});
