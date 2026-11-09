import { describe, expect, it } from 'vitest';
import { RELEASE_TRAIN_BEHIND_MS, releaseCadence } from './release-cadence-model.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const H = 3_600_000;

describe('releaseCadence', () => {
  it('names an unknown installed version and never guesses', () => {
    const view = releaseCadence({ installedVersion: null, newestVersion: 'v3.30.0', newestPublishedAt: ago(H), now });
    expect(view.line).toContain('Installed unknown · newest published 3.30.0');
    expect(view.line).not.toContain('(behind)');
  });
  it('names an unknown publish time without a warning', () => {
    for (const at of [null, undefined, 'not-a-date']) {
      const view = releaseCadence({ installedVersion: '3.29.15', newestVersion: 'v3.30.0', newestPublishedAt: at, now });
      expect(view).toMatchObject({ tone: 'neutral', behind: false });
      expect(view.line).toContain('Last published release: unknown');
    }
  });
  it('is fresh inside the window', () => {
    const view = releaseCadence({ installedVersion: '3.30.0', newestVersion: 'v3.30.0', newestPublishedAt: ago(RELEASE_TRAIN_BEHIND_MS), now });
    expect(view).toMatchObject({ tone: 'ok', behind: false });
    expect(view.line).toContain('Last published release: 2h ago');
  });
  it('warns when the newest release is older than two hours', () => {
    const view = releaseCadence({ installedVersion: '3.29.15', newestVersion: 'v3.30.0', newestPublishedAt: ago(5 * H), now });
    expect(view).toMatchObject({ tone: 'warn', behind: true });
    expect(view.line).toContain('Installed 3.29.15 · newest published 3.30.0 (behind)');
    expect(view.line).toContain('Release train is behind: no release in 5h');
  });
  it('adds no gap text when the versions match', () => {
    const view = releaseCadence({ installedVersion: '3.30.0', newestVersion: 'v3.30.0', newestPublishedAt: ago(H), now });
    expect(view.line).toBe('Installed 3.30.0 · newest published 3.30.0 · Last published release: 1h ago');
  });
});
