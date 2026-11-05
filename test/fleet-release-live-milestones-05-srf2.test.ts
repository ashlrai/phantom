import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetReleaseLive } from '../src/cli/fleet-release-live.js';
import type { MilestoneEvidence } from '../src/core/fleet/release-live-notice.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = '2026-11-05T02:00:00.000Z';
const repo = 'ashlrai/phantom', tag = 'v3.30.6';
const evidence = (version = '3.30.6', overrides: Partial<MilestoneEvidence> = {}): MilestoneEvidence => ({ repo, version, observedAt: now, ...overrides });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'milestone-')); dirs.push(root);
  let feed: MilestoneEvidence | null = null, installed: MilestoneEvidence | null = null, fail = false;
  const output: string[] = [];
  const deps = { runsDir: root, now: () => new Date(now), output: (text: string) => output.push(text), error: () => {},
    run: async () => ({ code: 0, stdout: JSON.stringify({ tag_name: tag, published_at: '2026-11-05T01:00:00Z', html_url: `https://github.com/${repo}/releases/tag/${tag}`, draft: false, prerelease: false }) }),
    feed: async () => { if (fail) throw new Error('offline'); return feed; }, installed: async () => installed };
  const run = async (extra: string[] = []) => { output.length = 0; expect(await cmdFleetReleaseLive(['--repo', repo, '--tag', tag, '--json', ...extra], deps)).toBe(0); return JSON.parse(output[0]!); };
  return { root, run, deps, setFeed: (v: MilestoneEvidence | null) => { feed = v; }, setInstalled: (v: MilestoneEvidence | null) => { installed = v; }, setFail: (v: boolean) => { fail = v; } };
}

it('announces independently observed milestones once and retries failed reads', async () => {
  const t = setup(); t.setFail(true);
  let result = await t.run();
  expect(result.observations.map((x: { status: string }) => x.status)).toEqual(['observed', 'unknown', 'unknown']);
  expect(result.notices.map((x: { stage: string }) => x.stage)).toEqual(['published']);
  t.setFail(false); t.setFeed(evidence());
  result = await t.run(); expect(result.notices.map((x: { stage: string }) => x.stage)).toEqual(['feed-ready']);
  t.setInstalled(evidence('3.31.0'));
  result = await t.run(); expect(result.notices.map((x: { stage: string }) => x.stage)).toEqual(['installed']);
  expect((await t.run()).notices).toHaveLength(0);
  const outbox = readFileSync(join(t.root, 'leader', 'MASON-OUTBOX.md'), 'utf8');
  expect(outbox.match(/^## /gm)).toHaveLength(3);
  expect(outbox).not.toContain('picks it up through self-update');
});

it('rejects mismatched and stale evidence and respects semver precedence', async () => {
  const t = setup();
  for (const bad of [evidence('3.30.5'), evidence('3.30.6-rc.1'), evidence('3.30.6', { repo: 'other/repo' }), evidence('3.30.6', { observedAt: '2026-11-05T01:00:00Z' })]) {
    t.setFeed(bad); const result = await t.run(); expect(result.observations[1].status).toBe('unknown');
  }
  t.setFeed(evidence('3.30.10')); expect((await t.run()).observations[1].status).toBe('observed');
});

it('keeps a dry run write-free and an ordinary first run baselines', async () => {
  const t = setup(); t.setFeed(evidence());
  const dry = await t.run(['--dry-run']); expect(dry.notices).toHaveLength(2);
  expect(existsSync(join(t.root, 'leader'))).toBe(false);
  expect(await cmdFleetReleaseLive(['--repo', repo], t.deps)).toBe(0);
  expect(existsSync(join(t.root, 'leader', 'MASON-OUTBOX.md'))).toBe(false);
  expect((await t.run()).notices).toHaveLength(2);
});

it('reports the absent local desktop identity contract', async () => {
  const t = setup(); const output: string[] = [];
  expect(await cmdFleetReleaseLive(['--repo', repo, '--tag', tag, '--json'], { ...t.deps, installed: undefined, output: text => output.push(text) })).toBe(0);
  expect(JSON.parse(output[0]!).observations[2]).toMatchObject({ status: 'unknown', reason: 'no safe desktop installed-version read contract available' });
});
