import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runQueueRejectionTrace, type TraceDependencies } from '../examples/agents/queue-rejection-trace.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';

const dirs: string[] = [];
const now = () => Date.parse('2026-10-31T12:00:00Z');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rejection-trace-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'leader/drop'), { recursive: true });
  await writeFile(join(dir, 'queue/ready.tsv'), '');
  return dir;
}
async function run(args: string[], deps: TraceDependencies = {}) {
  let text = '';
  const code = await runQueueRejectionTrace(args, { now, ...deps, write: value => { text += value; } });
  return { code, output: JSON.parse(text), text };
}
function readers(dir: string): TraceDependencies {
  return { readQueue: opts => readFleetQueue({ ...opts, runsDir: dir }), readJournal: opts => readLeaderJournal({ ...opts, runsDir: dir }) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('queue rejection trace', () => {
  it('correlates exact IDs and basenames, preserves latest reasons and never invents ingest times', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), [
      '2026-10-30 01:00:00\tRQ-EXAMPLE\t13\tolder',
      '2026-10-31 01:00:00\tRQ-EXAMPLE\t14\tlatest',
      '2026-10-31 02:00:00\tRQ-EXAMPLE-OTHER\t99\twrong',
    ].join('\n'));
    await writeFile(join(dir, 'leader/drop/ingest.log'), [
      'reject RQ-EXAMPLE.md older-ingest',
      '2026-10-31T10:00:00Z reject /tmp/RQ-EXAMPLE.md latest-ingest',
      'reject RQ-EXAMPLE-OTHER.md wrong',
      'accept RQ-EXAMPLE.md accepted',
      'reject RQ-EXAMPLE.md.bak wrong',
    ].join('\n'));
    const result = await run(['--job', 'RQ-EXAMPLE', '--limit', '1'], readers(dir));
    expect(result.code).toBe(0);
    expect(result.output.sources).toEqual({ precheck: 'healthy', ingest: 'healthy' });
    expect(result.output.timeline).toHaveLength(1);
    expect(result.output.timeline[0]).toMatchObject({ source: 'precheck', code: '14', reason: 'latest' });
    expect(result.output.latest.ingest).toEqual({ source: 'ingest', at: null, code: 'reject', reason: 'latest-ingest' });
    expect(result.output.truncated).toBe(true);
    const full = await run(['--job', 'RQ-EXAMPLE'], readers(dir));
    expect(full.output.timeline).toHaveLength(4);
    expect(full.output.timeline.slice(2).map((row: { at: string | null; reason: string }) => [row.at, row.reason])).toEqual([[null, 'latest-ingest'], [null, 'older-ingest']]);
    expect(full.text).not.toContain('wrong');
    expect(full.text).not.toContain('/tmp/');
  });

  it('degrades each source independently, including thrown readers', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '2026-10-31 01:00:00\tRQ-X\t14\tblocked\n');
    const missing = await run(['--job', 'RQ-X'], readers(dir));
    expect(missing.code).toBe(1);
    expect(missing.output.sources).toEqual({ precheck: 'healthy', ingest: 'missing' });
    expect(missing.output.latest.precheck.reason).toBe('blocked');
    await writeFile(join(dir, 'leader/drop/ingest.log'), 'reject RQ-X.md denied\n');
    const thrown = await run(['--job', 'RQ-X'], { ...readers(dir), readQueue: async () => { throw new Error('private'); } });
    expect(thrown.code).toBe(1);
    expect(thrown.output.sources).toEqual({ precheck: 'degraded', ingest: 'healthy' });
    expect(thrown.output.latest.ingest.reason).toBe('denied');
    expect(thrown.text).not.toContain('private');
  });

  it('scrubs untrusted reasons and emits no paths or sensitive log lines', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '2026-10-31 01:00:00\tRQ-X\t14\tpassword=fake-secret-value\n');
    await writeFile(join(dir, 'leader/drop/ingest.log'), 'reject RQ-X.md Authorization: Bearer fake-secret-value\nreject RQ-X.md /Users/example/private/file\n');
    const result = await run(['--job', 'RQ-X'], readers(dir));
    expect(result.text).not.toContain('fake-secret-value');
    expect(result.text).not.toContain('/Users/example');
    expect(result.output.latest.ingest.reason).toContain('~');
    expect(result.output.timeline).toHaveLength(2);
  });

  it('validates bounded arguments without reads and returns JSON errors', async () => {
    let reads = 0;
    const deps: TraceDependencies = { readQueue: async () => { reads++; throw new Error('secret'); } };
    for (const args of [[], ['--job', '../x'], ['--job', ''], ['--job', 'RQ-X', '--limit', '0'], ['--job', 'RQ-X', '--wait-ms', '30001'], ['--job', 'RQ-X', '--job', 'RQ-Y'], ['--job', 'RQ-X', '--limit', '1.5']]) {
      expect((await run(args, deps)).code).toBe(2);
    }
    expect(reads).toBe(0);
  });

  it('waits only within its bound, returns early on evidence, and handles cancellation', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
    await writeFile(join(dir, 'leader/drop/ingest.log'), '');
    let waits = 0;
    const deps = readers(dir);
    const result = await run(['--job', 'RQ-X', '--wait-ms', '2500'], { ...deps, wait: async () => { waits++; } });
    expect(result.code).toBe(0);
    expect(waits).toBe(3);
    waits = 0;
    const found = await run(['--job', 'RQ-X', '--wait-ms', '3000'], { ...deps, wait: async () => { waits++; await writeFile(join(dir, 'leader/drop/ingest.log'), 'reject RQ-X.md denied\n'); } });
    expect(waits).toBe(1);
    expect(found.output.latest.ingest.reason).toBe('denied');
    await writeFile(join(dir, 'leader/drop/ingest.log'), '');
    const controller = new AbortController();
    const interrupted = await run(['--job', 'RQ-X', '--wait-ms', '3000'], { ...deps, signal: controller.signal, wait: async () => { controller.abort(); throw new Error('private'); } });
    expect(interrupted).toEqual({ code: 130, output: { error: 'interrupted' }, text: '{"error":"interrupted"}\n' });
  });

});
