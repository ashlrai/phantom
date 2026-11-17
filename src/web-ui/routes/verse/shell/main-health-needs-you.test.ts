import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetMainHealth } from '../../../../core/fleet/main-health.js';
import { deriveMainHealthNeedsYou } from './main-health-needs-you.js';
import type { MainHealthData } from './main-health-query.js';

const repo: MainHealthData['repos'][number] = { repo: 'phantom', branch: 'master', sha: 'abcdef0123', state: 'red',
  checkedAt: '2026-11-01T00:00:00Z', failingCheck: 'build', fixJobs: [], nightlyRed: null };
const data: MainHealthData = { v: 1, generatedAt: '2026-11-01T00:00:00Z', source: 'ok', statusAt: null,
  stale: false, guardianOff: false, red: 1, repos: [repo] };
const derive = (value: MainHealthData) => deriveMainHealthNeedsYou({ kind: 'available', data: value });

describe('main health needs you', () => {
  it('escalates a still-red branch after duplicate empty finishes through the existing guardian policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guardian-empty-'));
    try {
      await mkdir(join(root, 'supervisor'));
      await mkdir(join(root, 'metrics'));
      const now = Date.now(), job = 'FIXUP-MAIN-phantom-abcdef0';
      await writeFile(join(root, 'supervisor/status-main-guardian.md'),
        `| phantom | master | abcdef0 | red | | build | ${job} | |\n`);
      const finish = { event: 'finish', job, ts: new Date(now - 1000).toISOString(), empty: true, exit_code: 0 };
      await writeFile(join(root, 'metrics/jobs.jsonl'), [
        { event: 'launch', job, ts: new Date(now - 2000).toISOString() }, finish, finish,
      ].map(row => JSON.stringify(row)).join('\n'));
      for (let poll = 0; poll < 2; poll++) {
        const health = await readFleetMainHealth({ runsDir: root, now: () => now });
        expect(derive(health).filter(item => item.severity === 'urgent')).toMatchObject([
          { id: 'main-red-phantom', title: 'phantom master is red with no fix job: build' },
        ]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('escalates a held failure with a stop-retrying step, and leaves an independent red repo on the normal alert', () => {
    const held = { ...repo, emptyAttempts: 2, retryHold: true };
    const other = { ...repo, repo: 'locus', emptyAttempts: 1, retryHold: false };
    expect(derive({ ...data, red: 2, repos: [held, other] })).toMatchObject([
      { id: 'main-red-phantom', severity: 'urgent', title: 'phantom master is red after 2 empty fix attempts: build',
        nextStep: expect.stringContaining('Do not retry the same fix') },
      { id: 'main-red-locus', title: 'locus master is red with no fix job: build', nextStep: 'Read ~/.ashlr-runs/guardian/guardian.log' },
    ]);
  });

  it('shows a red branch without a fix job', () => {
    expect(derive(data)).toMatchObject([{ id: 'main-red-phantom', severity: 'urgent',
      title: 'phantom master is red with no fix job: build', detail: expect.stringContaining('abcdef0'),
      nextStep: expect.stringContaining('guardian.log'), open: { kind: 'pane', paneId: 'fleet-lanes' } }]);
  });
  it.each([{ ...repo, fixJobs: ['job'] }, { ...repo, state: 'green' as const }, { ...repo, state: 'unknown' as const }])('does not show a healthy, unknown, or assigned repo', value => expect(derive({ ...data, repos: [value] })).toEqual([]));
  it('shows the kill switch alongside red repos and prefers it over stale', () => {
    expect(derive({ ...data, guardianOff: true, stale: true }).map(item => item.id)).toEqual(['main-red-phantom', 'main-guardian-off']);
  });
  it('shows stale status alongside red repos', () => {
    expect(derive({ ...data, stale: true }).map(item => item.id)).toEqual(['main-red-phantom', 'main-guardian-stale']);
    expect(derive({ ...data, repos: [], stale: true })[0]?.title).toContain('no status file');
    expect(derive({ ...data, repos: [], stale: true, statusAt: '2026-11-01T00:00:00Z' })[0]?.title).toContain('has not written since');
  });
  it('returns nothing without a read', () => expect(deriveMainHealthNeedsYou(undefined)).toEqual([]));
});
