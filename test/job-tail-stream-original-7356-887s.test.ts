import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdJobTail, type JobTailDeps } from '../src/cli/job.js';
import { classifyJobLine } from '../src/core/fleet/job-tail-words.js';
import { getFleetJobTail, type FleetJobTailV1 } from '../src/core/fleet/runs-job-tail.js';

const id = 'RQ-STREAMTEST';
const ts = '2026-11-24T12:00:00.000Z';
const snapshot = (status: FleetJobTailV1['status']): FleetJobTailV1 => ({
  schema: 'fleet.job.tail.v1', job: id, generatedAt: ts, status,
  headline: 'Job status', message: status === 'finished' ? 'Job finished.' : null,
  events: [{ ts, source: 'log', text: 'hello [redacted]' }, { ts, source: 'log', text: '$ run task' }],
  truncated: false, cursor: { log: null, ledger: 0 }, detail: null, controls: null,
} as unknown as FleetJobTailV1);

async function run(status: FleetJobTailV1['status'], args: string[] = ['--json'], mode: 'job' | 'session' = 'job', follow?: JobTailDeps['follow']) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdJobTail([id, ...args], { snapshot: async () => snapshot(status), follow, out: line => out.push(line), err: line => err.push(line) }, mode);
  return { code, out, err };
}
const records = (lines: string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>);

describe('original job tail stream contract', () => {
  it('classifies heuristically with errors taking precedence', () => {
    expect(classifyJobLine('log', 'tool failed')).toBe('error');
    expect(classifyJobLine('status', 'fatal result')).toBe('error');
    expect(classifyJobLine('log', '$ run')).toBe('tool');
    expect(classifyJobLine('log', 'done successfully')).toBe('result');
    expect(classifyJobLine('log', 'hello')).toBe('say');
  });
  it('emits typed running records using only supplied redacted text', async () => {
    const result = await run('live');
    expect(result.code).toBe(0);
    const lines = records(result.out);
    expect(lines.map(line => line.kind)).toEqual(['say', 'say', 'tool']);
    for (const line of lines) expect(line).toEqual(expect.objectContaining({ schema: 'fleet.job.tail.line.v1', ts, text: expect.any(String), source: expect.any(String) }));
    expect(result.out.join()).toContain('hello [redacted]');
    expect(result.out.join()).not.toContain('raw fixture content');
    expect(lines[0]?.status).toBe('live');
  });
  it('puts a finished snapshot result after history', async () => {
    const result = await run('finished', ['--json', '--follow']);
    expect(records(result.out).map(line => line.kind)).toEqual(['say', 'say', 'tool', 'result']);
    expect(records(result.out).at(-1)).toMatchObject({ text: 'Job finished.', status: 'finished' });
  });
  it('preserves the follow cursor and emits drained terminal status last', async () => {
    const follow: NonNullable<JobTailDeps['follow']> = async (_id, cursor, options) => {
      expect(cursor).toEqual(snapshot('live').cursor);
      options.onEvent({ ts, source: 'log', text: 'more work' });
      options.onEvent({ ts, source: 'status', text: 'Job finished.' });
    };
    const result = await run('live', ['--json', '--follow'], 'job', follow);
    expect(records(result.out).slice(-2).map(line => line.kind)).toEqual(['say', 'result']);
  });
  it('reports unknown jobs and preserves session errors and output', async () => {
    expect(await run('unknown', [])).toMatchObject({ code: 1, out: [], err: ['No job with that id.'] });
    const unknown = await run('unknown');
    expect(unknown.code).toBe(1);
    expect(records(unknown.out)).toEqual([expect.objectContaining({ schema: 'fleet.job.tail.line.v1', kind: 'error', text: 'No job with that id.', source: 'status', ts })]);
    expect(await run('unknown', ['--json'], 'session')).toMatchObject({ code: 2, out: [], err: [`No session ${id} on this computer. See: phm sessions`] });
    const session = records((await run('live', ['--json'], 'session')).out);
    expect(session[0]).toMatchObject({ status: 'live', detail: null, controls: null });
    expect(session[0]).not.toHaveProperty('schema');
    expect(session[1]).not.toHaveProperty('kind');
  });
  it('serializes a real temporary runs snapshot', async () => {
    const runs = await mkdtemp(join(tmpdir(), 'tail-stream-'));
    try {
      await writeFile(join(runs, `${id}.launch`), `launched ${id} codex pid 4242 base 1234\n`);
      await writeFile(join(runs, `${id}.log`), 'hello fixture\n');
      const tail = await getFleetJobTail(id, { runsDir: runs });
      const output: string[] = [];
      expect(await cmdJobTail([id, '--json', '--runs-dir', runs], { out: line => output.push(line) })).toBe(0);
      expect(records(output).some(line => line.text === tail.events.find(e => e.source === 'log')?.text)).toBe(true);
    } finally { await rm(runs, { recursive: true, force: true }); }
  });
});
