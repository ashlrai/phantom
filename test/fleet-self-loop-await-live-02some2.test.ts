import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSelfLoopAwait } from '../src/cli/fleet-self-loop-await.js';
import { cmdFleetSelfLoopRecord } from '../src/cli/fleet-self-loop-record.js';

const AFTER = '2026-01-01T00:00:00.000Z';
const T0 = Date.parse('2026-01-01T00:00:01.000Z');
const PRIVATE = 'PRIVATE-FAKE-REPORT-TEXT';
const setup = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'await-live-'))); return { dir, file: join(dir, 'result.json') }; };
const argv = (file: string, after = AFTER) => ['--result-file', file, '--after', after, '--timeout-ms', '500', '--poll-ms', '10', '--json'];

async function awaitRun(file: string, sleep: () => Promise<void> | void = () => {}, after = AFTER) {
  const out: string[] = [];
  let clock = 0, reads = 0;
  const code = await cmdFleetSelfLoopAwait(argv(file, after), {
    output: x => out.push(x), now: () => clock,
    read: async p => { reads++; return { kind: 'text', text: readFileSync(p, 'utf8') }; },
    sleep: async ms => { clock += ms; await sleep(); },
  });
  return { code, out, reads, json: JSON.parse(out[0]!) };
}

// Produces running then completed snapshots through the real record command and
// calls `observe` after each persisted pass (while the loop is "running").
async function produce(file: string, failTick: number | undefined, observe: () => Promise<void>) {
  let clock = T0, ticks = 0;
  const code = await cmdFleetSelfLoopRecord(['--result-file', file, '--live', '--duration-ms', '5000', '--interval-ms', '1000', '--max-ticks', '2'], {
    output: () => {}, now: () => clock,
    loopDeps: { now: () => clock, sleep: async ms => { clock += ms; await observe(); }, onSignal: () => () => {},
      tick: async () => { ticks++; return { exitCode: ticks === failTick ? 1 : 0, report: { tick: ticks, text: PRIVATE } }; } },
  });
  return code;
}

const live = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, startedAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:02.000Z', status: 'running',
  latest: { v: 1, record: 'pass', pass: 1, exitCode: 0, state: 'ran', report: PRIVATE }, ...over,
});

describe('fleet self-loop-await live records', () => {
  it('keeps polling on running snapshots and succeeds once completed', async () => {
    const { dir, file } = setup();
    try {
      let sawRunning = 0;
      const seen: string[] = [];
      await produce(file, undefined, async () => {
        const r = await awaitRun(file);
        seen.push(r.json.reason); sawRunning++;
      });
      // Every mid-run poll timed out (never finished early on a running record).
      expect(sawRunning).toBeGreaterThan(0);
      expect(seen.every(x => x === 'timed out')).toBe(true);
      const done = await awaitRun(file);
      expect(done.code).toBe(0);
      expect(done.json).toMatchObject({ ok: true, reason: 'completed', finishedAt: expect.any(String),
        summary: { ticks: 2, failures: 0, termination: 'max-ticks' } });
      expect(done.out[0]).not.toContain(PRIVATE);
      expect(done.out[0]).not.toContain('lastReport');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns nonzero for a completed summary with failures', async () => {
    const { dir, file } = setup();
    try {
      await produce(file, 2, async () => {});
      const { code, json, out } = await awaitRun(file);
      expect(code).toBe(1);
      expect(json).toMatchObject({ ok: false, reason: 'loop failed', summary: { failures: 1 } });
      expect(out[0]).not.toContain(PRIVATE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('picks up a running record turning completed mid-poll', async () => {
    const { dir, file } = setup();
    try {
      await produce(file, undefined, async () => {});
      const completed = readFileSync(file, 'utf8');
      writeFileSync(file, live());
      let n = 0;
      const r = await awaitRun(file, () => { if (++n === 3) writeFileSync(file, completed); });
      expect(n).toBe(3);
      expect(r.code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats stale running and completed snapshots as not yet done', async () => {
    const { dir, file } = setup();
    try {
      await produce(file, undefined, async () => {});
      expect((await awaitRun(file, undefined, '2026-01-01T00:00:02.000Z')).json).toMatchObject({ ok: false, reason: 'timed out' });
      writeFileSync(file, live());
      expect((await awaitRun(file, undefined, '2026-01-01T00:00:02.000Z')).json).toMatchObject({ ok: false, reason: 'timed out' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed status/latest combinations', async () => {
    const { dir, file } = setup();
    try {
      await produce(file, undefined, async () => {});
      const final = JSON.parse(readFileSync(file, 'utf8'));
      const pass = JSON.parse(live()).latest;
      const bad: Record<string, unknown>[] = [
        { status: 'completed', latest: pass },
        { status: 'running', latest: final.latest },
        { status: 'paused' },
        { status: 'running', latest: { ...pass, pass: 0 } },
        { status: 'running', latest: { ...pass, pass: 1.5 } },
        { status: 'running', latest: { ...pass, exitCode: 'x' } },
        { status: 'running', latest: null },
        { status: 'running', latest: [] },
        { status: 'running', summary: {} },
        { updatedAt: '2025-12-31T00:00:00.000Z' },
        { updatedAt: 'tomorrow' },
        { startedAt: 5 },
        { v: 2 },
        { status: 'completed', latest: { ...final.latest, failures: 99 } },
        { status: 'completed', latest: { ...final.latest, ticks: -1 } },
        { status: 'completed', latest: { ...final.latest, termination: 'weird' } },
      ];
      for (const over of bad) {
        const base = (over['latest'] as { record?: string } | undefined)?.record === 'summary' ? { ...final } : JSON.parse(live());
        writeFileSync(file, JSON.stringify({ ...base, ...over }));
        const r = await awaitRun(file);
        expect(r.json, JSON.stringify(over)).toMatchObject({ ok: false, reason: 'malformed record' });
        expect(r.code).toBe(1);
        expect(r.out[0]).not.toContain(PRIVATE);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
