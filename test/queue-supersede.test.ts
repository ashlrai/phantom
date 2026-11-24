import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import { formatQueueBatches, readQueueBatches } from '../src/core/queue/batches.js';
import { cycleOf, planSupersede, supersedeQueue, supersedeText } from '../src/core/queue/supersede.js';

const job = (id: string, repo = 'phantom', queued = true) => ({ id, repo, queued });

describe('planSupersede', () => {
  it('reads the cycle from C<number>, <number>S and <number>C endings only', () => {
    expect(cycleOf('RQ-PHX-RECUTCOREC541')).toEqual({ family: 'RQ-PHX-RECUTCORE', cycle: 541 });
    expect(cycleOf('RQ-PHX-RETURNSTEMPORAL539S')).toEqual({ family: 'RQ-PHX-RETURNSTEMPORAL', cycle: 539 });
    expect(cycleOf('RQ-PHX-RECUT-540C')).toEqual({ family: 'RQ-PHX-RECUT', cycle: 540 });
    for (const id of ['RQ-DEVINCLOUD-WIKI2-N17', 'RQ-EMPTYCLASS17Q8', 'RQ-SUPERSEDEN17XQ8', 'RQ-ROUTER-MUSTSPLIT', 'RQ-DOC5', 'RQ-FIXC5', '']) expect(cycleOf(id)).toBeNull();
  });
  it('keeps the newest cycle of an area and reports the older ones with the newer id', () => {
    expect(planSupersede([job('RQ-PHX-RECUTCOREC544'), job('RQ-PHX-RECUTCOREC541'), job('RQ-PHX-RECUTCOREC539')])).toEqual([
      { id: 'RQ-PHX-RECUTCOREC539', repo: 'phantom', family: 'RQ-PHX-RECUTCORE', cycle: 539, supersededBy: 'RQ-PHX-RECUTCOREC544' },
      { id: 'RQ-PHX-RECUTCOREC541', repo: 'phantom', family: 'RQ-PHX-RECUTCORE', cycle: 541, supersededBy: 'RQ-PHX-RECUTCOREC544' },
    ]);
  });
  it('keeps different areas, different repos and ids without a cycle', () => {
    expect(planSupersede([
      job('RQ-PHX-RECUTCOREC541'), job('RQ-PHX-RECUTDOCSC544'), // different areas
      job('RQ-PHX-RECUTWEBC541'), job('RQ-PHX-RECUTWEBC544', 'locus'), // different repos
      job('RQ-DEVINCLOUD-WIKI2-N17'), job('RQ-DEVINCLOUD-WIKI3-N17'), job('RQ-EMPTYCLASS17Q8'), job('RQ-EMPTYCLASS18Q8'), // no cycle
      job('RQ-PHX-SAME541S'), job('RQ-PHX-SAME541S'), // the same cycle twice is not older
    ])).toEqual([]);
  });
  it('lets a claimed newer cycle replace a queued one, and never replaces a claimed job', () => {
    expect(planSupersede([job('RQ-PHX-AREAC541'), job('RQ-PHX-AREAC544', 'ashlrai/Phantom', false)]).map(row => [row.id, row.supersededBy]))
      .toEqual([['RQ-PHX-AREAC541', 'RQ-PHX-AREAC544']]);
    expect(planSupersede([job('RQ-PHX-AREAC541', 'phantom', false), job('RQ-PHX-AREAC544')])).toEqual([]);
  });
  it('gives the same output for any input order', () => {
    const jobs = [job('RQ-B540S'), job('RQ-A12C', 'locus'), job('RQ-B544S'), job('RQ-A15C', 'locus'), job('RQ-BC541')];
    expect(JSON.stringify(planSupersede([...jobs].reverse()))).toBe(JSON.stringify(planSupersede(jobs)));
    expect(planSupersede(jobs).map(row => row.id)).toEqual(['RQ-A12C', 'RQ-B540S', 'RQ-BC541']);
  });
});

describe('phm queue supersede', () => {
  let runs: string, queue: string;
  const row = (id: string, repo = 'phantom', lane = 'codex-personal') => `${id}\t${repo}\t${lane}\tmid\t/q/prompts/${id}.md`;
  const READY = [row('RQ-PHX-RECUTCOREC541'), row('RQ-PHX-RECUTDOCSC541'), row('RQ-PHX-RECUTCOREC544'), row('RQ-PHX-RECUTDOCSC544', 'locus'),
    row('RQ-EMPTYCLASS17Q8'), row('RQ-PHX-PARKEDC530', 'phantom', 'PARKED-BYHAND.codex-local'), row('RQ-PHX-PARKEDC544'), row('RQ-PHX-RUNC541')].join('\n') + '\n';
  const ROUTER = ['# Router queue', '- CLAIMED 09:15 dispatchd RQ-PHX-RECUTCOREC541 (P1, repo=phantom): recut core.',
    '- READY RQ-PHX-RECUTCOREC544 (P1, repo=phantom): recut core.', '- READY RQ-PHX-LATER500S (repo=phantom): not restocked yet.',
    '- READY RQ-PHX-LATER512S (repo=phantom): newer.', '- CLAIMED 10:00 dispatchd RQ-PHX-RUNC544 (repo=phantom): running, no ready row.',
    '- READY RQ-PLAIN (repo=phantom): no cycle.', ''].join('\n');
  const read = (name: string) => readFile(join(queue, name), 'utf8');
  const fast = { verifyMs: 0, now: () => new Date(2026, 10, 17, 16, 1, 10) };
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), 'queue-supersede-')); queue = join(runs, 'queue');
    await mkdir(queue);
    await writeFile(join(queue, 'ready.tsv'), READY); await writeFile(join(queue, 'router-queue.md'), ROUTER);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(runs, { recursive: true, force: true }); });

  it('is a dry run by default and shows the count on the queue view', async () => {
    const report = await supersedeQueue({ runsDir: runs });
    expect(report).toMatchObject({ schema: 'queue.supersede.v1', applied: false, queued: 10, count: 3 });
    expect(report.superseded.map(r => [r.id, r.supersededBy])).toEqual([
      ['RQ-PHX-LATER500S', 'RQ-PHX-LATER512S'], ['RQ-PHX-RECUTCOREC541', 'RQ-PHX-RECUTCOREC544'], ['RQ-PHX-RUNC541', 'RQ-PHX-RUNC544']]);
    expect(JSON.stringify(await supersedeQueue({ runsDir: runs }))).toBe(JSON.stringify(report));
    expect(supersedeText(report)[0]).toBe('3 queued jobs have a newer cycle queued. Run phm queue supersede --apply to archive them.');
    expect(await read('ready.tsv')).toBe(READY);
    expect(await read('router-queue.md')).toBe(ROUTER);
    await expect(read('superseded.tsv')).rejects.toMatchObject({ code: 'ENOENT' });
    const view = await readQueueBatches(runs);
    expect(view.superseded).toBe(3);
    expect(formatQueueBatches(view)).toContain('\n3 queued jobs have a newer cycle queued. Run phm queue supersede --apply to archive them.');
  });

  it('applies: archives the older rows, marks router lines, writes one event per job and leaves the rest alone', async () => {
    const report = await supersedeQueue({ runsDir: runs, apply: true, ...fast });
    expect(report).toMatchObject({ applied: true, count: 3 });
    expect(await read('superseded.tsv')).toBe(`${row('RQ-PHX-RECUTCOREC541')}\n${row('RQ-PHX-RUNC541')}\n`);
    expect(await read('ready.tsv')).toBe(READY.replace(`${row('RQ-PHX-RECUTCOREC541')}\n`, '').replace(`${row('RQ-PHX-RUNC541')}\n`, ''));
    expect(await read('router-queue.md')).toBe(ROUTER
      .replace('- CLAIMED 09:15 dispatchd RQ-PHX-RECUTCOREC541', '- SUPERSEDED-BY-RQ-PHX-RECUTCOREC544 09:15 dispatchd RQ-PHX-RECUTCOREC541')
      .replace('- READY RQ-PHX-LATER500S', '- SUPERSEDED-BY-RQ-PHX-LATER512S RQ-PHX-LATER500S'));
    expect((await read('dispatch-events.log')).split('\n')).toEqual([
      '2026-11-17 16:01:10 SUPERSEDED RQ-PHX-LATER500S by RQ-PHX-LATER512S repo=phantom src=phm-queue-supersede',
      '2026-11-17 16:01:10 SUPERSEDED RQ-PHX-RECUTCOREC541 by RQ-PHX-RECUTCOREC544 repo=phantom src=phm-queue-supersede',
      '2026-11-17 16:01:10 SUPERSEDED RQ-PHX-RUNC541 by RQ-PHX-RUNC544 repo=phantom src=phm-queue-supersede', '']);

    // Second run: nothing left to do and nothing written.
    const before = await Promise.all(['ready.tsv', 'router-queue.md', 'superseded.tsv', 'dispatch-events.log'].map(read));
    expect(await supersedeQueue({ runsDir: runs, apply: true, ...fast })).toMatchObject({ applied: false, count: 0, superseded: [] });
    expect(await Promise.all(['ready.tsv', 'router-queue.md', 'superseded.tsv', 'dispatch-events.log'].map(read))).toEqual(before);
    expect((await readQueueBatches(runs)).superseded).toBe(0);
  });

  it('reports an apply the dispatcher overwrote as not applied, and a second run finishes it', async () => {
    // The dispatcher puts the file back after every write.
    const undo = { ...fast, attempts: 1, sleep: async () => { await writeFile(join(queue, 'ready.tsv'), READY); } };
    expect(await supersedeQueue({ runsDir: runs, apply: true, ...undo })).toMatchObject({ applied: false, count: 3 });
    expect((await read('dispatch-events.log')).trim().split('\n')).toHaveLength(1); // only the router-only job is done
    expect(await supersedeQueue({ runsDir: runs, apply: true, ...fast })).toMatchObject({ applied: true, count: 2 });
    expect(await read('superseded.tsv')).toBe(`${row('RQ-PHX-RECUTCOREC541')}\n${row('RQ-PHX-RUNC541')}\n`); // archived once
    expect((await read('dispatch-events.log')).trim().split('\n')).toHaveLength(3);
  });

  it('runs from the CLI with stable JSON, plain text and usage errors', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runs);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdQueue(['supersede', '--json'])).toBe(0);
      expect(await cmdQueue(['supersede', '--json'])).toBe(0);
      expect(log.mock.calls[1]![0]).toBe(log.mock.calls[0]![0]);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(await supersedeQueue({ runsDir: runs }));
      expect(await cmdQueue(['supersede'])).toBe(0);
      expect(String(log.mock.calls[2]![0]).split('\n')[2]).toBe('RQ-PHX-RECUTCOREC541 (phantom) is replaced by RQ-PHX-RECUTCOREC544');
      expect(await read('ready.tsv')).toBe(READY);
      expect(await cmdQueue(['supersede', '--bogus'])).toBe(2);
      expect(await cmdQueue(['supersede', '--help'])).toBe(0);
      await rm(queue, { recursive: true });
      expect(await cmdQueue(['supersede', '--json'])).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ error: 'Queue unavailable' });
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});
