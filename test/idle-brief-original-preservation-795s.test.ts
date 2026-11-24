import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, LEADER_COMPACT_FILE, readCompactBrief, writeCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import * as host from '../src/core/fleet/host-families.js';
import * as backlog from '../src/core/release/backlog.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idle-brief-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  vi.spyOn(host, 'readHostFamilies').mockResolvedValue(host.groupHostFamilies(null));
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: at, counts: { ok: 1, due: 2, stale: 3, unknown: 1 }, repos: [] });
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

it('preserves observed holds before trimming and writes them to JSON and text', async () => {
  const names = [...Array.from({ length: 63 }, (_, i) => `worker${i}`), 'personal'];
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify(Object.fromEntries(names.map(l => [l, { target: 4, held: l === 'personal' }]))));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: at, lanes: Object.fromEntries(names.map(l => [l, { running: l === 'personal' ? 1 : 4, held: l === 'personal' }])) }));
  const rows = Array.from({ length: 500 }, (_, i) => ({ event: 'launch', job: `family${String.fromCharCode(97 + i % 26, 97 + Math.floor(i / 26))}-${i}`, lane: 'personal', ts: at }));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const brief = await writeCompactBrief(dir, now);
  const saved = JSON.parse(await readFile(join(dir, LEADER_COMPACT_FILE), 'utf8'));
  expect(brief.omitted).toBeGreaterThan(0);
  expect(saved.lanes.some((lane: { lane: string }) => lane.lane === 'personal')).toBe(false);
  expect(saved.whyIdle).toEqual(['Codex on hold: 1 running']);
  expect(compactBriefLines(brief)).toContain(saved.whyIdle[0]);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(8192);
  expect(compactBriefLines(brief)).toContain('Release: 2 due, 3 stale, 1 unknown');
});

it('reports empty ready queues, caps reasons, and does not infer a quota stop', async () => {
  const lanes = ['personal', 'local', 'claude', 'gemini'];
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify(Object.fromEntries(lanes.map(l => [l, { target: 4, held: false }]))));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: at, lanes: Object.fromEntries(lanes.map(l => [l, { running: 1, held: false }])), budget: { personal: { used_pct: 99, hours_to_reset: 10, burn_pct_per_hour: 50 } } }));
  await writeFile(join(dir, 'queue/ready.tsv'), '');
  const brief = await readCompactBrief(dir, now);
  expect(brief.whyIdle).toHaveLength(3);
  expect(brief.whyIdle.every(reason => reason.includes('0 ready jobs'))).toBe(true);
  expect(compactBriefLines(brief)).toEqual(expect.arrayContaining(brief.whyIdle));
  await writeFile(join(dir, 'queue/ready.tsv'), lanes.map(l => `work-${l}\tphantom\t${l}\twork\tplain`).join('\n'));
  expect((await readCompactBrief(dir, now)).whyIdle).toEqual([]);
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: at, lanes: Object.fromEntries(lanes.map(l => [l, { running: 4, held: false }])) }));
  await writeFile(join(dir, 'queue/ready.tsv'), '');
  expect((await readCompactBrief(dir, now)).whyIdle).toEqual([]);
});

it('leaves missing observations unknown', async () => {
  const brief = await readCompactBrief(dir, now);
  expect(brief.state).toBe('no data');
  expect(brief.whyIdle).toEqual([]);
  expect(brief.sources['queue/ready.tsv'].state).toBe('missing');
});
