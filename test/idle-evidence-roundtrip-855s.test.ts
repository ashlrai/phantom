import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { writeCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { readWhyIdle } from '../src/core/fleet/why-idle-read.js';
import { readFleetBrief } from '../src/core/fleet/status-brief.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import * as host from '../src/core/fleet/host-families.js';
import * as backlog from '../src/core/release/backlog.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

it('round trips pre-trim observations through all readers and rejects invalid evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-roundtrip-'));
  const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
    vi.spyOn(host, 'readHostFamilies').mockResolvedValue(host.groupHostFamilies(null));
    vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: at, counts: { ok: 1, due: 2, stale: 3, unknown: 1 }, repos: [] });
    vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
    await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
    const names = [...Array.from({ length: 63 }, (_, i) => `worker${i}`), 'personal'];
    await writeFile(join(dir, 'queue/slots.json'), JSON.stringify(Object.fromEntries(names.map(l => [l, { target: 4, held: l === 'personal' }]))));
    await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: at, lanes: Object.fromEntries(names.map(l => [l, { running: l === 'personal' ? 1 : 4, held: l === 'personal' }])) }));
    const rows = Array.from({ length: 500 }, (_, i) => ({ event: 'launch', job: `family${String.fromCharCode(97 + i % 26, 97 + Math.floor(i / 26))}-${i}`, lane: 'personal', ts: at }));
    await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
    const brief = await writeCompactBrief(dir, now);
    const file = join(dir, 'queue/leader-brief.json');
    const text = await readFile(file, 'utf8'), saved = JSON.parse(text);
    const expected = ['Codex on hold: 1 running'];
    expect(brief.whyIdle).toEqual(expected);
    expect(saved.lanes.some((l: { lane: string }) => l.lane === 'personal')).toBe(false);
    expect(saved.idleEvidence.lanes).toEqual([expect.objectContaining({ lane: 'personal', held: true, running: 1 })]);
    expect(Buffer.byteLength(JSON.stringify(saved.idleEvidence))).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(text)).toBeLessThan(8192);
    expect(await readWhyIdle(dir, now)).toEqual(expected);
    expect((await readFleetBrief({ runsDir: dir, now })).whyIdle).toEqual(expected);
    const fail = async () => { throw new Error('unavailable'); };
    const api = createFleetRunsApi({ runsDir: dir, now: () => now, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour: fail });
    let body = '';
    await api({} as VerseApiContext, {} as IncomingMessage, { writeHead() {}, end(value: string) { body = value; } } as unknown as ServerResponse, '/api/verse/fleet/runs', 'GET');
    expect(JSON.parse(body).whyIdle).toEqual(expected);
    expect(await readWhyIdle(dir, now + 120_001)).toEqual([]);
    expect(await readWhyIdle(dir, now - 1)).toEqual([]);
    for (const projection of [null, { lanes: [{ lane: 'personal', held: 'yes' }], attention: [] }, { lanes: [], attention: [{ lane: 'personal', status: 'quiet' }] }, { lanes: Array(4).fill(saved.idleEvidence.lanes[0]), attention: [] }]) {
      await writeFile(file, JSON.stringify({ ...saved, idleEvidence: projection }));
      expect(await readWhyIdle(dir, now)).toEqual([]);
    }
    await writeFile(file, JSON.stringify({ schema: saved.schema, at, whyIdle: expected }));
    expect(await readWhyIdle(dir, now)).toEqual([]);
    await writeFile(file, JSON.stringify({ schema: saved.schema, at, lanes: [{ lane: 'personal', running: 1, target: 4, held: true }] }));
    expect(await readWhyIdle(dir, now)).toEqual(expected);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});
