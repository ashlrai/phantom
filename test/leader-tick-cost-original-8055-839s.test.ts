import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, LEADER_COMPACT_FILE, readCompactBrief, writeCompactBrief, type CompactLeaderBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as hostFamilies from '../src/core/fleet/host-families.js';
import * as backlog from '../src/core/release/backlog.js';
import * as gitLatency from '../src/core/fleet/git-merge-latency.js';
import { localIso } from '../src/core/fleet/runs-parked-queue.js';

let dir: string;
const now = Date.parse('2026-11-21T12:00:00Z');
const tick = (offset: number, seconds: number) => `${localIso(new Date(now + offset)).slice(0, 19).replace('T', ' ')} tick run={} wall=${seconds}s\n`;
beforeEach(async () => {
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: new Date(now).toISOString(), counts: { ok: 1, due: 2, stale: 3, unknown: 1 }, repos: [] });
  vi.spyOn(gitLatency, 'readGitMergeLatency').mockResolvedValue(gitLatency.mergeLatencyFromGit([], [], now / 1000));
  vi.spyOn(hostFamilies, 'readHostFamilies').mockResolvedValue(groupHostFamilies(null));
  dir = await mkdtemp(join(tmpdir(), 'leader-tick-cost-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

it('persists the observed two-hour p95 within the brief budget', async () => {
  await writeFile(join(dir, 'dispatchd.log'), tick(-7201000, 999) + tick(-60000, 48) + tick(-30000, 90) + tick(-1000, 145) + tick(1000, 999));
  const rows = Array.from({ length: 500 }, (_, i) => ({ job: `family-${i}-long-name`, event: 'launch', ts: new Date(now).toISOString() }));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const brief = await readCompactBrief(dir, now);
  expect(brief.tickWallP95).toBe(145);
  expect(Buffer.byteLength(JSON.stringify(brief))).toBeLessThan(8192);
  await writeCompactBrief(dir, now);
  const saved = await readFile(join(dir, LEADER_COMPACT_FILE), 'utf8');
  expect(JSON.parse(saved).tickWallP95).toBe(145);
  expect(Buffer.byteLength(saved)).toBeLessThan(8192);
  const { tickWallP95: _removed, ...legacy } = brief;
  const stored: CompactLeaderBrief = legacy;
  expect(compactBriefLines(stored)).toEqual(compactBriefLines(brief));
});

it('reports unknown for a missing log or no in-window tick samples', async () => {
  expect((await readCompactBrief(dir, now)).tickWallP95).toBeNull();
  await writeFile(join(dir, 'dispatchd.log'), tick(-7201000, 48) + tick(1000, 90));
  expect((await readCompactBrief(dir, now)).tickWallP95).toBeNull();
});
