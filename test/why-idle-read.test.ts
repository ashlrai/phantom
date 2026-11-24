import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { readWhyIdle } from '../src/core/fleet/why-idle-read.js';
import { readFleetBrief } from '../src/core/fleet/status-brief.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
it('shares fresh brief reasons with both APIs and refuses absent, stale or malformed evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-')), now = Date.parse('2026-11-21T12:00:00Z');
  try {
    await mkdir(join(dir, 'queue'));
    const file = join(dir, 'queue/leader-brief.json');
    expect(await readWhyIdle(dir, now)).toEqual([]);
    await writeFile(file, JSON.stringify({ schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(), lanes: [{ lane: 'codex', running: 1, target: 4, held: false, queuedReady: 0 }] }));
    const expected = ['Codex: 3 free spots, 0 ready jobs'];
    expect(await readWhyIdle(dir, now)).toEqual(expected);
    expect((await readFleetBrief({ runsDir: dir, now })).whyIdle).toEqual(expected);
    const fail = async () => { throw new Error('unavailable'); };
    const api = createFleetRunsApi({ runsDir: dir, now: () => now, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour: fail });
    let body = '';
    await api({} as VerseApiContext, {} as IncomingMessage, { writeHead() {}, end(text: string) { body = text; } } as unknown as ServerResponse, '/api/verse/fleet/runs', 'GET');
    expect(JSON.parse(body).whyIdle).toEqual(expected);
    await writeFile(file, JSON.stringify({ schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(),
      lanes: [{ lane: 'codex', running: 1, target: 4, held: false, queuedReady: 0 }], whyIdle: ['unsupported cached claim'] }));
    expect(await readWhyIdle(dir, now)).toEqual(expected);
    expect(await readWhyIdle(dir, now + 120_001)).toEqual([]);
    expect(await readWhyIdle(dir, now - 1)).toEqual([]);
    await writeFile(file, 'plain');
    expect(await readWhyIdle(dir, now)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('requires structured evidence and rejects malformed nested readings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-evidence-'));
  const now = Date.parse('2026-11-21T12:00:00Z');
  const base = { schema: 'leader.compact-brief.v1', at: new Date(now).toISOString() };
  const lane = { lane: 'codex', running: 1, target: 4, held: false, queuedReady: 0 };
  try {
    await mkdir(join(dir, 'queue'));
    const check = async (value: unknown) => {
      await writeFile(join(dir, 'queue/leader-brief.json'), JSON.stringify(value));
      return readWhyIdle(dir, now);
    };
    expect(await check({ ...base, whyIdle: ['unsupported cached claim'] })).toEqual([]);
    expect(await check({ ...base, pools: [{ pool: 'codex', usedPct: 95, verdict: 'over' }] })).toEqual([]);
    for (const value of [
      { lanes: [null] }, { lanes: [{ ...lane, running: -1 }] },
      { lanes: [{ ...lane, target: '4' }] }, { lanes: [{ ...lane, held: 'false' }] },
      { lanes: [{ ...lane, queuedReady: '0' }] }, { lanes: [{ ...lane, pause_new_until: -1 }] },
      { pools: [null] }, { pools: [{ pool: 'codex', usedPct: -1, verdict: 'over' }] },
      { attention: [null] }, { admission: { lastWhy: 1 } },
      { admission: { lastWhy: 'over_host', startsPerHour: -1 } },
    ]) expect(await check({ ...base, lanes: [lane], ...value })).toEqual([]);
    expect(await check({ ...base, lanes: [lane], padding: 'x'.repeat(8192) })).toEqual([]);
    const expected = ['Codex: 3 free spots, 0 ready jobs'];
    expect(await check({ ...base, lanes: [lane] })).toEqual(expected);
    expect((await readFleetBrief({ runsDir: dir, now })).whyIdle).toEqual(expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
