import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { briefText, readFleetBrief } from '../src/core/fleet/status-brief.js';

it('reports only fresh and valid observed snapshot evidence while retaining status metrics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-status-'));
  const now = Date.parse('2026-11-21T12:00:00Z');
  const base = { schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(), lanes: [
    { lane: 'claude', running: 1, target: 4, held: true },
    { lane: 'codex', running: 1, target: 4, held: false, queuedReady: 0 },
  ] };
  try {
    await mkdir(join(dir, 'queue'));
    const file = join(dir, 'queue/leader-brief.json');
    const check = async (data: unknown, time = now) => {
      await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
      return briefText(await readFleetBrief({ runsDir: dir, now: time }));
    };
    const fresh = await check(base);
    expect(fresh.slice(0, 2)).toEqual(['Claude on hold: 1 running', 'Codex: 3 free spots, 0 ready jobs']);
    expect((await check(base, now + 120_000))[0]).toBe(fresh[0]);
    for (const data of [base, { ...base, schema: 'other' }, { ...base, lanes: [null] }, { ...base, attention: {} }, '{']) {
      const lines = await check(data, data === base ? now + 120_001 : now);
      expect(lines[0]).toMatch(/^Merged:/);
      expect(lines).toHaveLength(4);
    }
    expect((await check(base, now - 1))[0]).toMatch(/^Merged:/);
    expect((await check({ ...base, lanes: [{ lane: 'codex', running: null, target: null, held: null, queuedReady: null }] }))[0]).toMatch(/^Merged:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
