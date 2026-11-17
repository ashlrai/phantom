/**
 * `phm job tail <id>` and fleet.job.tail.v1 (runs-job-tail.ts).
 *
 * Fixtures are built in a temp runs dir. Redaction is tested through a stubbed
 * detector (the `redact` seam) so no credential-shaped value appears in this
 * file; the default path is checked to be the job detail's scrubJobLogLine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdJobTail } from '../src/cli/job.js';
import { followFleetJobTail, getFleetJobTail, type FleetJobTailEvent } from '../src/core/fleet/runs-job-tail.js';
import { scrubJobLogLine } from '../src/core/fleet/runs-job-detail.js';

let runs: string;
const JOB = 'RQ-TAILTEST';
const T0 = new Date('2026-11-17T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'job-tail-')); });
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

async function put(name: string, text: string, mtime: Date): Promise<void> {
  await writeFile(join(runs, name), text);
  await utimes(join(runs, name), mtime, mtime);
}
async function runningJob(log: string): Promise<void> {
  await put(`${JOB}.launch`, `launched ${JOB} codex pid 4242 base 1234\n`, at(0));
  await put(`${JOB}.base.meta`, 'MODEL codex frontier model-x\n', at(0));
  await put(`${JOB}.log`, log, at(5));
}
function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => { lines.push(l); }, err: (l: string) => { lines.push(`ERR ${l}`); } };
}

describe('getFleetJobTail', () => {
  it('says plainly when the job is unknown and exits 1', async () => {
    const tail = await getFleetJobTail(JOB, { runsDir: runs });
    expect(tail.status).toBe('unknown');
    expect(tail.events).toEqual([]);
    const io = capture();
    expect(await cmdJobTail([JOB, '--runs-dir', runs], io)).toBe(1);
    expect(io.lines.join('\n')).toContain(`Job ${JOB} is unknown here: no launch, log or result is recorded on this machine.`);
  });

  it('reports a finished job with its result and PR link', async () => {
    await put(`${JOB}.launch`, `launched ${JOB} codex pid 4242 base 1234\n`, at(0));
    await put(`${JOB}.log`, 'all done\n', at(5));
    await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/42\nAUTO_MERGE on\n', at(10));
    const tail = await getFleetJobTail(JOB, { runsDir: runs });
    expect(tail.status).toBe('finished');
    expect(tail.detail.prUrl).toBe('https://github.com/example/repo/pull/42');
    expect(tail.message).toBe(`Job ${JOB} finished. Result: published https://github.com/example/repo/pull/42.`);
    const io = capture();
    // --follow on a finished job prints once and returns instead of waiting.
    expect(await cmdJobTail([JOB, '--runs-dir', runs, '--follow'], io)).toBe(0);
    expect(io.lines).toContain('all done');
    expect(io.lines[0]).toContain('PR https://github.com/example/repo/pull/42');
  });

  it('says the log is empty so far for a running job with an empty log', async () => {
    await runningJob('');
    const tail = await getFleetJobTail(JOB, { runsDir: runs });
    expect(tail).toMatchObject({ status: 'no-log', message: 'Log is open but empty so far.', detail: { state: 'running', lane: 'codex', model: 'model-x' } });
    expect(tail.headline).toContain(`started ${at(0).toISOString()}`);
    const io = capture();
    expect(await cmdJobTail([JOB, '--runs-dir', runs, '--json'], io)).toBe(0);
    expect(io.lines.map(l => JSON.parse(l) as FleetJobTailEvent)).toEqual([
      expect.objectContaining({ source: 'status', text: expect.stringContaining('Log is open but empty so far.'), ts: expect.any(String) }),
    ]);
  });

  it('passes every log and ledger line through the redactor (stubbed detector)', async () => {
    await runningJob('step one\nSTUBMARK step two\n');
    await mkdir(join(runs, 'metrics'));
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ job: JOB, event: 'launch', ts: at(0).toISOString(), lane: 'STUBMARK' })}\n`);
    const seen: string[] = [];
    const redact = (line: string) => { seen.push(line); return line.replaceAll('STUBMARK', '[redacted]'); };
    const tail = await getFleetJobTail(JOB, { runsDir: runs, redact, lines: 5 });
    expect(tail.events).toEqual([
      { ts: at(0).toISOString(), source: 'event', text: 'launch lane=[redacted]' },
      { ts: null, source: 'log', text: 'step one' },
      { ts: null, source: 'log', text: '[redacted] step two' },
    ]);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(tail)).not.toContain('STUBMARK');
  });

  it('defaults to the job detail redaction (control bytes stripped)', async () => {
    await runningJob('bell\u0007here\n');
    const tail = await getFleetJobTail(JOB, { runsDir: runs });
    expect(tail.events.at(-1)?.text).toBe(scrubJobLogLine('bell\u0007here'));
    expect(tail.events.at(-1)?.text).toBe('bell here');
  });

  it('rejects a bad id and bad flags with usage', async () => {
    await expect(getFleetJobTail('../x', { runsDir: runs })).rejects.toThrow('invalid fleet job id');
    for (const args of [[], ['../x'], [JOB, '--lines', '0'], [JOB, '--lines', '121'], [JOB, '--runs-dir', 'rel'], [JOB, '--json', '--json']]) {
      expect(await cmdJobTail(args, capture())).toBe(2);
    }
  });
});

describe('follow mode', () => {
  it('picks up an appended line, then stops when the job finishes', async () => {
    await runningJob('first\n');
    const snapshot = await getFleetJobTail(JOB, { runsDir: runs });
    const events: FleetJobTailEvent[] = [];
    let tick = 0;
    const result = await followFleetJobTail(JOB, snapshot.cursor, {
      runsDir: runs,
      redact: line => line.replaceAll('STUBMARK', '[redacted]'),
      onEvent: e => { events.push(e); },
      wait: async () => {
        tick++;
        if (tick === 1) await appendFile(join(runs, `${JOB}.log`), 'second STUBMARK\npartial');
        if (tick === 2) await appendFile(join(runs, `${JOB}.log`), ' line\n');
        if (tick === 3) await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/43\n', new Date(Date.now() + 60_000));
      },
    });
    expect(result).toBe('finished');
    expect(events.filter(e => e.source === 'log').map(e => e.text)).toEqual(['second [redacted]', 'partial line']);
    expect(events.at(-1)).toMatchObject({ source: 'status', text: `Job ${JOB} finished. Result: published https://github.com/example/repo/pull/43.` });
  });

  it('streams through the CLI until aborted', async () => {
    await runningJob('first\n');
    const controller = new AbortController();
    const io = capture();
    const done = cmdJobTail([JOB, '--runs-dir', runs, '--follow', '--json'], {
      out: line => {
        io.out(line);
        if (line.includes('"text":"first"')) void appendFile(join(runs, `${JOB}.log`), 'appended\n');
        if (line.includes('"text":"appended"')) controller.abort();
      },
      err: io.err, signal: controller.signal, intervalMs: 20,
    });
    expect(await done).toBe(0);
    const appended = io.lines.map(l => JSON.parse(l) as FleetJobTailEvent).find(e => e.text === 'appended');
    expect(appended).toMatchObject({ source: 'log', ts: expect.any(String) });
  });
});
