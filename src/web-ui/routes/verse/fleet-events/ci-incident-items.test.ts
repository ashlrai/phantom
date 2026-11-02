import { describe, expect, it } from 'vitest';
import { busFeedItems } from './bus-feed-items.js';
import { ciIncidentItem } from './ci-incident-items.js';

const at = '2026-11-01T05:56:00Z';
const body = {
  kind: 'ci.failed-scheduled-run', repo: 'ashlrai/phantom', runId: 123, attempt: 2,
  url: 'https://github.com/ashlrai/phantom/actions/runs/123/attempts/2', workflow: 'CI',
  branch: 'master', headSha: 'a'.repeat(40), failedJobCount: 2,
  jobs: [{ id: 1, name: 'build', failedSteps: ['test'], failedStepCount: 1 },
    { id: 2, name: 'lint', failedSteps: ['lint'], failedStepCount: 1 }],
};
const envelope = (incidentBody: unknown = body) => ({ id: 'incident', from: 'system:ci', to: 'mason', priority: 'P1', ttl: 5000, body: incidentBody });

describe('CI incident feed items', () => {
  it('renders a scheduled failure and links to its attempt', () => {
    expect(ciIncidentItem(envelope(), at)).toEqual({ id: 'bus:incident', kind: 'ci', at,
      text: 'CI failed: ashlrai/phantom CI run 123, attempt 2 · 2 job(s): build, lint', url: body.url });
  });

  it('omits attempt one', () => {
    expect(ciIncidentItem(envelope({ ...body, attempt: 1 }), at)?.text)
      .toBe('CI failed: ashlrai/phantom CI run 123 · 2 job(s): build, lint');
  });

  it('bounds the displayed job names and count of names', () => {
    const jobs = [{ name: 'a'.repeat(50) }, { name: 'b'.repeat(50) }, { name: 'third' }];
    expect(ciIncidentItem(envelope({ ...body, failedJobCount: 3, jobs }), at)?.text)
      .toBe(`CI failed: ashlrai/phantom CI run 123, attempt 2 · 3 job(s): ${'a'.repeat(40)}, ${'b'.repeat(40)}`);
  });

  it('replaces a URL on another host with the run URL', () => {
    expect(ciIncidentItem(envelope({ ...body, url: 'https://example.com/run/123' }), at)?.url)
      .toBe('https://github.com/ashlrai/phantom/actions/runs/123');
  });

  it('rejects non-CI kinds, bad repositories, and invalid run IDs', () => {
    expect(ciIncidentItem(envelope({ ...body, kind: 'chat' }), at)).toBeNull();
    for (const repo of ['ashlrai/phantom/extra', 'ashlrai/phantom\n', '/bad', 'bad repo/name']) {
      expect(ciIncidentItem(envelope({ ...body, repo }), at)).toBeNull();
    }
    for (const runId of [0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
      expect(ciIncidentItem(envelope({ ...body, runId }), at)).toBeNull();
    }
  });

  it('renders unknown CI kinds with their suffix', () => {
    expect(ciIncidentItem(envelope({ ...body, kind: 'ci.queued' }), at)?.text)
      .toBe('CI queued: ashlrai/phantom run 123');
  });

  it('maps CI and chat envelopes with the same bus ID scheme', () => {
    const messages = [envelope(), { ...envelope({ kind: 'chat', text: 'hello' }), id: 'chat', from: 'alpha', to: 'beta' }]
      .map((entry, index) => ({ cursor: index + 1, receivedAt: 1, envelope: entry }));
    const items = busFeedItems({ v: 1, status: 'ok', messages, nextCursor: 2, timestamp: at });
    expect(items.map(item => [item.id, item.kind])).toEqual([['bus:incident', 'ci'], ['bus:chat', 'bus']]);
    expect(items[1]?.text).toBe('alpha -> beta [P1] hello');
  });
});
