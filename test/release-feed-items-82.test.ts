import { describe, expect, it } from 'vitest';
import { releaseFeedItems } from '../src/web-ui/routes/verse/feed/release-feed-items.js';

const at = '2026-11-10T12:00:00Z';
const response = (stages: unknown[]) => ({ schema: 'verse.release-stages.v1', tag: 'v3.30.8', checkedAt: at, stages });
describe('release feed observations', () => {
  it('alerts on incomplete asset evidence without inventing a count', () => {
    const stage = { stage: 'published', status: 'unknown', reason: 'desktop asset evidence incomplete; retry; missing or invalid: latest.json' };
    const items = releaseFeedItems(response([stage, stage]), null, at);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'alert', title: expect.stringContaining('missing or invalid') });
  });
  it('reports unknown feed and publication evidence without claiming success', () => {
    const items = releaseFeedItems(response([{ stage: 'published', status: 'unknown' }, { stage: 'feed-ready', status: 'unknown' }]), null, at);
    expect(items.map(item => item.title)).toEqual(['v3.30.8: publication or desktop asset state is unknown.', 'v3.30.8: updater feed availability is unknown.']);
  });
  it('shows installed native updates and observed feed evidence', () => {
    const items = releaseFeedItems(response([{ stage: 'feed-ready', status: 'observed', version: '3.30.8' }]), { phase: 'installed', version: '3.30.8', enabled: true, bytesReceived: 0, bytesTotal: null, reason: null }, at);
    expect(items.map(item => item.title)).toEqual(['v3.30.8: the updater feed serves 3.30.8.', 'v3.30.8: desktop update installed; restart is pending.']);
  });
});
