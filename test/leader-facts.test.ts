import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLeaderFacts } from '../src/core/fleet/leader-facts.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

describe('leader facts', () => {
  it('writes recent leader jobs and independent GitHub facts atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leader-facts-'));
    try {
      await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
      await writeFile(join(root, 'queue/router-queue.md'), '- READY RQ-A (repo=phantom, src=leader): work\n- READY RQ-B (repo=phantom, src=human): work\n- DONE RQ-OLD (repo=phantom, src=leader): old\n');
      await writeFile(join(root, 'metrics/jobs.jsonl'), [
        { event: 'launch', job: 'RQ-A', ts: '2026-01-02T00:00:00Z' },
        { event: 'publish', job: 'RQ-A', ts: '2026-01-02T01:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/7', result: 'ok' },
        { event: 'launch', job: 'RQ-OLD', ts: '2025-12-01T00:00:00Z' },
      ].map(row => JSON.stringify(row)).join('\n'));
      const gh: CloudGh = async args => ({ ok: true, stderr: '', stdout: JSON.stringify(args[1]?.includes('/pulls/') ? { state: 'closed', merged_at: '2026-01-02T02:00:00Z' } : args[1] === 'search/issues' ? { total_count: 3, incomplete_results: false } : { tag_name: 'v1' }) });
      const facts = await writeLeaderFacts(root, gh, Date.parse('2026-01-03T00:00:00Z'));
      expect(facts.jobs).toEqual([{ id: 'RQ-A', repo: 'ashlrai/phantom', publish_result: 'ok', pr_url: 'https://github.com/ashlrai/phantom/pull/7', pr_state: 'merged', merged_at: '2026-01-02T02:00:00Z' }]);
      expect(facts.repos).toEqual([{ repo: 'ashlrai/phantom', merged_24h: 3, latest_release_tag: 'v1' }]);
      expect(JSON.parse(await readFile(join(root, 'leader/facts.json'), 'utf8'))).toEqual(facts);
      expect(await readdir(join(root, 'leader'))).toEqual(['facts.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('discovers recent Q8 pull requests independently of the local ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leader-facts-'));
    try {
      const gh: CloudGh = async args => ({ ok: true, stderr: '', stdout: JSON.stringify(
        args[1] === 'search/issues' && args.some(a => a.includes('created:>='))
          ? { incomplete_results: false, items: [{ title: 'bridge: RQ-TESTN9NQ8', html_url: 'https://github.com/ashlrai/phantom/pull/4416' }] }
          : args[1]?.includes('/pulls/') ? { state: 'closed', merged_at: '2026-01-02T02:00:00Z' }
          : args[1] === 'search/issues' ? { total_count: 1, incomplete_results: false } : { tag_name: 'v1' },
      ) });
      const facts = await writeLeaderFacts(root, gh, Date.parse('2026-01-03T00:00:00Z'));
      expect(facts.sources.github).toBe('ok');
      expect(facts.jobs).toContainEqual({ id: 'RQ-TESTN9NQ8', repo: 'ashlrai/phantom', publish_result: 'published', pr_url: 'https://github.com/ashlrai/phantom/pull/4416', pr_state: 'merged', merged_at: '2026-01-02T02:00:00Z' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves unknowns when sources or GitHub are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leader-facts-'));
    try {
      await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
      await writeFile(join(root, 'queue/router-queue.md'), '- READY RQ-A (repo=phantom, src=leader): work');
      await writeFile(join(root, 'metrics/jobs.jsonl'), '{bad\n' + JSON.stringify({ job: 'RQ-A', event: 'launch', ts: '2026-01-02T00:00:00Z' }));
      const facts = await writeLeaderFacts(root, async () => { throw new Error('offline'); }, Date.parse('2026-01-03T00:00:00Z'));
      expect(facts.sources.jobs).toBe('partial'); expect(facts.jobs[0]?.pr_state).toBeNull();
      expect(facts.repos[0]).toMatchObject({ merged_24h: null, latest_release_tag: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
