/**
 * `phm job tail <id>` and fleet.job.tail.v1 (runs-job-tail.ts).
 *
 * Fixtures are built in a temp runs dir. Redaction is tested through a stubbed
 * detector (the `redact` seam) so no credential-shaped value appears in this
 * file; the default path is checked to be the job detail's scrubJobLogLine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdJobTail } from '../src/cli/job.js';
import { followFleetJobTail, getFleetJobTail, type FleetJobTailEvent } from '../src/core/fleet/runs-job-tail.js';
import { scrubJobLogLine } from '../src/core/fleet/runs-job-detail.js';
import { describeJob } from '../src/core/fleet/job-tail-words.js';

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
  beforeStat: undefined as undefined | ((path: string) => Promise<void>),
  afterStat: undefined as undefined | ((path: string) => Promise<void>),
  afterFileStat: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      await hooks.beforeStat?.(String(args[0]));
      const stat = await fs.lstat(...args);
      await hooks.afterStat?.(String(args[0]));
      return stat;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const file = await fs.open(...args);
      const stat = file.stat.bind(file);
      file.stat = (async () => {
        const info = await stat();
        await hooks.afterFileStat?.(String(args[0]));
        return info;
      }) as typeof file.stat;
      return file;
    },
  };
});

let runs: string;
const JOB = 'RQ-TAILTEST';
const T0 = new Date('2026-11-17T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'job-tail-')); });
afterEach(async () => {
  hooks.beforeOpen = hooks.beforeStat = hooks.afterStat = undefined;
  hooks.afterFileStat = undefined;
  await rm(runs, { recursive: true, force: true });
});

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
  it('resumes an incomplete ledger row without losing it at the snapshot cursor', async () => {
    await mkdir(join(runs, 'metrics'));
    const path = join(runs, 'metrics', 'jobs.jsonl');
    const line = JSON.stringify({ job: JOB, event: 'launch', ts: T0.toISOString() });
    await writeFile(path, line.slice(0, 20));
    const snapshot = await getFleetJobTail(JOB, { runsDir: runs });
    expect(snapshot.cursor.ledger).toBe(0);
    await appendFile(path, line.slice(20) + '\n');
    const controller = new AbortController();
    const events: FleetJobTailEvent[] = [];
    await followFleetJobTail(JOB, snapshot.cursor, {
      runsDir: runs, signal: controller.signal, onEvent: e => { events.push(e); },
      wait: async () => { controller.abort(); },
    });
    expect(events).toEqual([expect.objectContaining({ source: 'event', text: 'launch' })]);
  });

  it('reports an unreadable live snapshot without a resume cursor', async () => {
    await runningJob('unreadable fixture\n');
    hooks.beforeOpen = async path => {
      if (path === join(runs, `${JOB}.log`)) throw Object.assign(new Error('fixture refusal'), { code: 'EACCES' });
    };
    const snapshot = await getFleetJobTail(JOB, { runsDir: runs });
    expect(snapshot).toMatchObject({ status: 'no-log', cursor: { log: null } });
    expect(snapshot.events.filter(e => e.source === 'log')).toEqual([]);
  });

  it('keeps the ledger cursor tied to its read window during append', async () => {
    await mkdir(join(runs, 'metrics'));
    const path = join(runs, 'metrics', 'jobs.jsonl');
    const line = JSON.stringify({ job: JOB, event: 'launch', ts: T0.toISOString() }) + '\n';
    await writeFile(path, line);
    let changed!: () => void;
    const appended = new Promise<void>(done => { changed = done; });
    let probes = 0;
    hooks.beforeStat = async p => {
      if (p === path && ++probes === 2) await appended;
    };
    hooks.afterFileStat = async p => {
      if (p !== path) return;
      hooks.afterFileStat = undefined;
      await appendFile(path, line);
      changed();
    };
    const snapshot = await getFleetJobTail(JOB, { runsDir: runs });
    expect(snapshot.cursor.ledger).toBe(snapshot.events.filter(e => e.source === 'event').length * Buffer.byteLength(line));
  });

  it('keeps the snapshot log cursor tied to the returned lines during append', async () => {
    await runningJob('before\n');
    const path = join(runs, `${JOB}.log`);
    let probes = 0;
    let changed!: () => void;
    const appended = new Promise<void>(done => { changed = done; });
    hooks.beforeStat = async p => {
      if (p === path && ++probes === 2) await appended;
    };
    let first = true;
    hooks.afterStat = async p => {
      if (p !== path || !first) return;
      first = false;
      await appendFile(path, 'during\n');
      changed();
    };
    const snapshot = await getFleetJobTail(JOB, { runsDir: runs });
    const shown = snapshot.events.filter(e => e.source === 'log').map(e => e.text);
    expect(snapshot.cursor.log).toBe(Buffer.byteLength(shown.join('\n') + '\n'));
  });

  it('does not classify a degraded nonempty log without readable lines as live', () => {
    const words = describeJob({ state: 'running', sources: { log: 'degraded' },
      log: { source: 'live', bytes: 100, tail: [] } }, T0.getTime());
    expect(words).toMatchObject({ status: 'no-log', showLog: false });
    expect(words.text).toMatch(/unavailable|read|degraded/i);
  });

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
  it('drains output appended while terminal status is being observed', async () => {
    await runningJob('');
    await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/44\n', new Date(Date.now() + 60_000));
    hooks.beforeStat = async path => {
      if (path !== join(runs, `${JOB}.publish`)) return;
      hooks.beforeStat = undefined;
      await appendFile(join(runs, `${JOB}.log`), 'last write before status\n');
    };
    const events: FleetJobTailEvent[] = [];
    await followFleetJobTail(JOB, { log: 0, ledger: 0 }, {
      runsDir: runs, onEvent: e => { events.push(e); }, wait: async () => {},
    });
    expect(events.map(e => e.source)).toEqual(['log', 'status']);
    expect(events[0]?.text).toBe('last write before status');
  });

  it('preserves a UTF-8 line split across chunks and flushes a final unterminated line', async () => {
    const line = 'x'.repeat(256 * 1024 - 2) + 'é';
    await runningJob('prefix\n' + line + '\nlast without newline');
    await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/44\n', new Date(Date.now() + 60_000));
    const events: FleetJobTailEvent[] = [];
    await followFleetJobTail(JOB, { log: 0, ledger: 0 }, {
      runsDir: runs, redact: line => line, onEvent: e => { events.push(e); }, wait: async () => {},
    });
    const output = events.filter(e => e.source === 'log').map(e => e.text);
    expect(output.length).toBe(3);
    expect(output[0]).toBe('prefix');
    expect(output[1] === line).toBe(true);
    expect(output[2]).toBe('last without newline');
    expect(events.at(-1)?.source).toBe('status');
  });

  it('refuses a log swapped to a symlink between probe and open', async () => {
    await runningJob('safe'.repeat(20) + '\n');
    const path = join(runs, `${JOB}.log`);
    const target = join(runs, 'outside');
    await writeFile(target, 'private fixture\n');
    hooks.beforeOpen = async p => {
      if (p !== path) return;
      hooks.beforeOpen = undefined;
      await rm(path);
      await symlink(target, path);
    };
    const controller = new AbortController();
    const events: FleetJobTailEvent[] = [];
    await followFleetJobTail(JOB, { log: 0, ledger: 0 }, {
      runsDir: runs, signal: controller.signal, onEvent: e => { events.push(e); },
      wait: async () => { controller.abort(); },
    });
    expect(events.filter(e => e.source === 'log')).toEqual([]);
  });

  it('advances beyond a line larger than a follow chunk without leaking fragments', async () => {
    await runningJob('STUBMARK'.repeat(40_000) + '\nafter oversized\n');
    const controller = new AbortController();
    const events: FleetJobTailEvent[] = [];
    let ticks = 0;
    await followFleetJobTail(JOB, { log: 0, ledger: 0 }, {
      runsDir: runs, signal: controller.signal,
      redact: line => line.replaceAll('STUBMARK', '[redacted]'),
      onEvent: e => { events.push(e); },
      wait: async () => { if (++ticks === 5) controller.abort(); },
    });
    expect(events.map(e => e.text)).toContain('after oversized');
    expect(JSON.stringify(events)).not.toContain('STUBMARK');
  });

  it.each(['log', 'ledger'])('drains pending %s chunks before final status', async source => {
    await runningJob('');
    const count = 10_000;
    if (source === 'log') await writeFile(join(runs, `${JOB}.log`), ('x'.repeat(60) + '\n').repeat(count));
    else {
      await mkdir(join(runs, 'metrics'));
      await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
        (JSON.stringify({ job: JOB, event: 'launch', ts: T0.toISOString() }) + '\n').repeat(count));
    }
    await put(`${JOB}.publish`, 'RESULT PR https://github.com/example/repo/pull/44\n', new Date(Date.now() + 60_000));
    const events: FleetJobTailEvent[] = [];
    expect(await followFleetJobTail(JOB, { log: 0, ledger: 0 }, {
      runsDir: runs, onEvent: e => { events.push(e); }, wait: async () => {},
    })).toBe('finished');
    expect(events.filter(e => e.source === (source === 'log' ? 'log' : 'event'))).toHaveLength(count);
    expect(events.at(-1)?.source).toBe('status');
  });

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
