import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke, candidates, decodeConfig, history, launchdPlist, migrate, run, scheduleMatches, type Config } from '../src/core/routines/index.js';

const config: Config = {
  routines: [{ id: 'ai-tooling-changelog-radar', schedule: '* * * * *', prompt: 'Codex, Claude Code, Devin and Grok changelogs', capabilities: ['research'], tier: 'frontier', output: 'radar.md' }],
  executors: ['codex', 'claude'].map((kind, i) => ({ id: kind, kind: kind as 'codex' | 'claude', capabilities: ['research'], tier: 'frontier', cost: i, dailyLimit: 3 })),
};
describe('provider agnostic routines', () => {
  it('parses cron lists, ranges, steps, aliases, Sunday 7, and DOM/DOW OR in UTC', () => {
    const date = new Date('2026-10-25T13:10:00Z');
    for (const cron of ['*/10 12-14 * * 7', '0,10 13 1 * 0', '10 13 * 10 *']) expect(scheduleMatches(cron, date)).toBe(true);
    expect(scheduleMatches('@daily', date)).toBe(false);
    for (const cron of ['60 * * * *', '*/0 * * * *', '* * *', '* * * 13 *', '5-2 * * * *']) expect(() => scheduleMatches(cron, date)).toThrow();
  });
  it('runs radar on Codex and fails over to Claude on forced quota exhaustion, recording each attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routines-'));
    try {
      const call = vi.fn(async (e: Config['executors'][number]) => {
        if (e.kind === 'codex') throw new Error('usage exhausted');
        return { output: '# Radar' };
      });
      const now = new Date('2026-10-25T13:10:00Z');
      expect((await run(config, undefined, dir, call, now)).map(a => a.outcome)).toEqual(['quota', 'success']);
      expect(call.mock.calls.map(([e]) => e.kind)).toEqual(['codex', 'claude']);
      expect(await readFile(join(dir, 'output', 'radar.md'), 'utf8')).toBe('# Radar');
      expect(await readFile(join(dir, 'STATUS.md'), 'utf8')).toContain('claude | success');
      expect(await run(config, undefined, dir, call, now)).toEqual([]);
      expect(await history(dir)).toHaveLength(2);
      expect(candidates(config, config.routines[0]!, await history(dir), now).map(e => e.id)).toEqual(['claude']);
      const ok = vi.fn(async () => ({ output: 'Codex radar' }));
      expect((await run(config, config.routines[0]!.id, dir, ok, new Date('2026-10-26T13:10:00Z')))[0]?.executor).toBe('codex');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('uses real CLI adapters with existing auth, failing over without logging raw diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-cli-'));
    const previous = process.env['PATH'];
    try {
      await writeFile(join(dir, 'codex'), '#!/bin/sh\necho "usage limit reached" >&2\nexit 1\n', { mode: 0o700 });
      await writeFile(join(dir, 'claude'), `#!/bin/sh\necho '{"result":"Claude radar"}'\n`, { mode: 0o700 });
      process.env['PATH'] = dir;
      expect((await run(config, config.routines[0]!.id, dir, invoke)).map(a => a.outcome)).toEqual(['quota', 'success']);
      expect(await readFile(join(dir, 'output', 'radar.md'), 'utf8')).toBe('Claude radar');
      await writeFile(join(dir, 'codex'), '#!/bin/sh\necho "Codex radar"\n', { mode: 0o700 });
      expect((await run(config, config.routines[0]!.id, dir, invoke, new Date(Date.now() + 86_400_000)))[0]?.executor).toBe('codex');
    } finally { process.env['PATH'] = previous; await rm(dir, { recursive: true, force: true }); }
  });
  it('enforces limits and capability/tier requirements and escapes launchd arguments', () => {
    expect(candidates({ ...config, executors: config.executors.map(e => ({ ...e, dailyLimit: 0 })) }, config.routines[0]!, [], new Date())).toEqual([]);
    expect(candidates({ ...config, executors: config.executors.map(e => ({ ...e, capabilities: [] })) }, config.routines[0]!, [], new Date())).toEqual([]);
    expect(launchdPlist('/node', '/a&b.js', '/r.yaml')).toContain('/a&amp;b.js');
    expect(() => decodeConfig('routines: []')).toThrow();
  });
  it('records unavailable runs, stops ambiguous failures, and refuses an active lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-lock-'));
    try {
      const failed = vi.fn(async () => { throw new Error('unknown failure'); });
      expect((await run(config, config.routines[0]!.id, dir, failed)).map(a => a.outcome)).toEqual(['failed']);
      expect(failed).toHaveBeenCalledTimes(1);
      expect((await run({ ...config, executors: [] }, config.routines[0]!.id, dir, failed))[0]?.outcome).toBe('unavailable');
      await writeFile(join(dir, '.lock'), '');
      await expect(run(config, undefined, dir, failed)).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('imports a cron or pasted prompt without executing either', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routines-'));
    try {
      const file = join(dir, 'routines.yaml');
      await migrate('0 9 * * 1 echo hello', 'weekly', file);
      await migrate('Summarize all the recent changes in our project', 'daily', file);
      const c = decodeConfig(await readFile(file, 'utf8'));
      expect(c.routines[0]).toMatchObject({ schedule: '0 9 * * 1', command: 'echo hello' });
      expect(c.routines[1]).toMatchObject({ schedule: '@daily', prompt: 'Summarize all the recent changes in our project' });
      await expect(migrate('hello', 'daily', file)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
