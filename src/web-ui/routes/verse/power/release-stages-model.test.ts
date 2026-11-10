import { describe, expect, it } from 'vitest';
import { newerUninstallable, releaseStageRows, type ReleaseStagesView } from './release-stages-model.js';

const missing = 'desktop asset evidence incomplete; retry; missing or invalid: latest.json, manifest.json, manifest.json.sig, a.tgz, a.tgz.sig, b.tar.gz';
const noFeed: ReleaseStagesView = { tag: 'v3.30.8', stages: [
  { stage: 'published', status: 'unknown', version: null, reason: missing },
  { stage: 'feed-ready', status: 'unknown', version: null, reason: 'feed unavailable or unsupported' }] };
const full: ReleaseStagesView = { tag: 'v3.30.8', stages: [
  { stage: 'published', status: 'observed', version: 'v3.30.8', reason: null },
  { stage: 'feed-ready', status: 'observed', version: '3.30.8', reason: null }] };

describe('releaseStageRows', () => {
  it('lists missing assets briefly and says the feed does not serve the tag', () => {
    const rows = releaseStageRows(noFeed, '3.29.15');
    expect(rows[0]).toEqual({ label: 'Published', state: 'ok', text: 'v3.30.8 published' });
    expect(rows[1]!.state).toBe('missing');
    expect(rows[1]!.text).toContain('Feed does not serve v3.30.8 yet');
    expect(rows[2]).toEqual({ label: 'Installer assets', state: 'missing', text: 'Missing: latest.json, manifest.json, manifest.json.sig, a.tgz and 2 more' });
  });
  it('is all ok when everything is present', () => {
    expect(releaseStageRows(full, '3.29.15').map(r => [r.state, r.text])).toEqual([
      ['ok', 'v3.30.8 published'], ['ok', 'Feed serves v3.30.8'], ['ok', 'All 7 assets present']]);
  });
  it('is unknown when the newest release cannot be read', () => {
    const rows = releaseStageRows({ tag: null, stages: [] }, null);
    expect(rows[0]).toEqual({ label: 'Published', state: 'unknown', text: 'Newest release unknown' });
    expect(rows.every(r => r.state === 'unknown')).toBe(true);
  });
});

describe('newerUninstallable', () => {
  it('flags a newer tag the feed does not serve', () => { expect(newerUninstallable(noFeed, '3.29.15')).toEqual({ tag: 'v3.30.8' }); });
  it('is null once the feed serves it', () => { expect(newerUninstallable(full, '3.29.15')).toBeNull(); });
  it('is null when installed equals or exceeds the tag', () => {
    expect(newerUninstallable(noFeed, '3.30.8')).toBeNull();
    expect(newerUninstallable(noFeed, '3.30.9')).toBeNull();
    expect(newerUninstallable({ tag: null, stages: [] }, '3.29.15')).toBeNull();
  });
});
