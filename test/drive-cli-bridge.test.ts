import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDrive, driveControlPresent, parseDriveOptions } from '../src/cli/drive.js';
import { checkDriveExecutable, ScriptDriveBridge } from '../src/core/drive/script-bridge.js';
import type { DriveBridge, DriveSnapshot } from '../src/core/drive/supervisor.js';
import { projectDriveQueueV1, type DriveQueueV1 } from '../src/core/drive/queue-v1.js';
import { validateQueue, type QueueDocument } from '../src/core/queue/schema.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const snapshot: DriveSnapshot = { version: 1, pools: [{ id: 'codex-cmp', floor: 1, ceiling: 2 }],
  maxRunning: 2, paused: false, admission: 'open', jobs: [{ id: 'ready', pool: 'codex-cmp', state: 'READY', priority: 0 }] };
const reply = (result: unknown): string => JSON.stringify({ protocol: 'phm-drive/v1', result });

describe('DRIVER-1 queue.v1 scheduling seam', () => {
  const job = (id: string, status: DriveQueueV1['jobs'][number]['status'] = 'READY'): DriveQueueV1['jobs'][number] =>
    ({ id, status, priority: 'P0', pool: 'codex-cmp', tier: 'frontier', repo: 'phantom', deps: [] });
  it('requires all dependencies DONE, including missing dependencies', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [job('done', 'DONE'), job('pr', 'PR-OPEN'),
      { ...job('ready'), deps: ['done'] }, { ...job('waiting'), deps: ['pr'] }, { ...job('missing'), deps: ['unknown'] }] };
    expect(projectDriveQueueV1(queue).map(item => [item.id, item.state])).toEqual([
      ['done', 'HELD'], ['pr', 'HELD'], ['ready', 'READY'], ['waiting', 'HELD'], ['missing', 'HELD'],
    ]);
  });
  it('holds dependency cycles and unrouted imports; accounts for existing claims', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [job('claimed', 'CLAIMED'),
      { ...job('a'), deps: ['b'] }, { ...job('b'), deps: ['a'] },
      { ...job('unrouted'), tier: 'unspecified' }, { ...job('unranked'), priority: 'unknown' }] };
    expect(projectDriveQueueV1(queue).map(item => item.state)).toEqual(['STARTING', 'HELD', 'HELD', 'HELD', 'HELD']);
  });
  it('orders P0 before lower priorities without promoting held states', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [job('p0'), { ...job('p2'), priority: 'P2' }, job('hold', 'HOLD'), job('proposed', 'PROPOSED'), job('blocked', 'BLOCKED')] };
    const projected = projectDriveQueueV1(queue);
    expect(projected[0]!.priority).toBeGreaterThan(projected[1]!.priority);
    expect(projected.slice(2).every(item => item.state === 'HELD')).toBe(true);
  });
  it('rejects duplicate ids and invalid scheduling fields', () => {
    expect(() => projectDriveQueueV1({ schema: 'queue.v1', jobs: [job('a'), job('a')] })).toThrow('Duplicate');
    expect(() => projectDriveQueueV1({ schema: 'queue.v1', jobs: [{ ...job('a'), deps: ['a'] }] })).toThrow('Invalid');
  });
  it('accepts the full canonical status set and holds statuses without scheduling semantics', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [
      job('ready'), job('claimed', 'CLAIMED'), job('split', 'SPLIT-PARENT'), job('fixup', 'FIXUP'),
      job('land', 'LAND'), job('retired', 'RETIRED'), job('dropped', 'DROPPED'), { ...job('on-dropped'), deps: ['dropped'] }] };
    expect(projectDriveQueueV1(queue).map(item => item.state)).toEqual(
      ['READY', 'STARTING', 'HELD', 'HELD', 'HELD', 'HELD', 'HELD', 'HELD']);
  });
  it('accepts a QueueDocument validated by the real queue store contract', () => {
    const doc: QueueDocument = { schema: 'queue.v1', jobs: [
      { id: 'done', status: 'DONE', priority: 'P0', pool: 'codex-cmp', tier: 'frontier', repo: 'phantom',
        deps: [], scope: 's', acceptance: 'a', claims: [{ owner: 'w1', claimedAt: '2026-10-28T00:00:00Z', finishedAt: '2026-10-28T01:00:00Z' }] },
      { id: 'fixup', status: 'FIXUP', priority: 'P1', pool: 'devin', tier: 'work', repo: 'phantom',
        deps: [], scope: 's', acceptance: 'a', claims: [] },
      { id: 'next', status: 'READY', priority: 'P2', pool: 'devin', tier: 'work', repo: 'phantom',
        deps: ['done'], scope: 's', acceptance: 'a', claims: [] }] };
    validateQueue(doc);
    expect(projectDriveQueueV1(doc).map(item => [item.id, item.state])).toEqual([
      ['done', 'HELD'], ['fixup', 'HELD'], ['next', 'READY']]);
  });
});

describe('drive bridge transport', () => {
  it('passes versioned structured arguments without shell interpolation', async () => {
    const command = vi.fn(async () => reply(snapshot));
    const check = vi.fn(async () => {});
    const bridge = new ScriptDriveBridge('/owned/drive-bridge', command, check);
    expect(await bridge.snapshot()).toEqual(snapshot);
    expect(command).toHaveBeenCalledWith('/owned/drive-bridge', ['snapshot', '{"protocol":"phm-drive/v1"}']);
    expect(check).toHaveBeenCalledWith('/owned/drive-bridge');
  });

  it.each(['not-json', '{"protocol":"old","result":true}', '{"protocol":"phm-drive/v1"}'])('refuses malformed reply %s', async text => {
    const bridge = new ScriptDriveBridge('/bridge', async () => text, async () => {});
    await expect(bridge.acquire()).rejects.toThrow();
  });

  it('does not disclose child errors', async () => {
    const bridge = new ScriptDriveBridge('/bridge', async () => { throw new Error('sensitive-child-output'); }, async () => {});
    await expect(bridge.acquire()).rejects.toThrow('Drive bridge acquire failed');
  });

  it('requires explicit acknowledgements and a well-formed ownership lease', async () => {
    const command = vi.fn(async () => reply(false));
    const bridge = new ScriptDriveBridge('/bridge', command, async () => {});
    await expect(bridge.reap('lease')).rejects.toThrow('not acknowledged');
    await expect(bridge.acquire()).rejects.toThrow('ownership lease');
    await expect(bridge.launch('lease', 'job')).rejects.toThrow('launch acknowledgement');
    command.mockResolvedValue(reply(null));
    expect(await bridge.acquire()).toBeNull();
    command.mockResolvedValue(reply('0123456789abcdef'));
    expect(await bridge.acquire()).toBe('0123456789abcdef');
  });

  it('runs only the reserved publish.sh through Phantom Secrets with literal arguments', async () => {
    const argv = ['/work/a b', '$(must-stay-literal)'];
    const command = vi.fn(async (exe: string) => exe === 'phantom' ? '' : reply({ argv }));
    const check = vi.fn(async () => {});
    const bridge = new ScriptDriveBridge('/owned/bridge', command, check);
    expect(await bridge.reservePublish('lease', 'job')).toBe(true);
    await bridge.publish('/owned/publish.sh', 'job', 'lease');
    expect(command).toHaveBeenLastCalledWith('phantom', ['exec', '--', '/owned/publish.sh', ...argv]);
    expect(check).toHaveBeenCalledWith('/owned/publish.sh');
    await expect(bridge.publish('/owned/publish.sh', 'job', 'lease')).rejects.toThrow('no durable reservation');
  });

  it('refuses a different pusher and a reservation from a different lease', async () => {
    const command = vi.fn(async () => reply({ argv: [] }));
    const bridge = new ScriptDriveBridge('/owned/bridge', command, async () => {});
    await bridge.reservePublish('lease', 'job');
    await expect(bridge.publish('/owned/publish.sh', 'job', 'other')).rejects.toThrow('no durable reservation');
    await expect(bridge.publish('/owned/git', 'job', 'lease')).rejects.toThrow('only publishes through publish.sh');
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed publication with the same reservation', async () => {
    const command = vi.fn(async (exe: string) => {
      if (exe === 'phantom') throw new Error('unknown');
      return reply({ argv: ['job'] });
    });
    const bridge = new ScriptDriveBridge('/owned/bridge', command, async () => {});
    await bridge.reservePublish('lease', 'job');
    await expect(bridge.publish('/owned/publish.sh', 'job', 'lease')).rejects.toThrow('unknown');
    await expect(bridge.publish('/owned/publish.sh', 'job', 'lease')).rejects.toThrow('no durable reservation');
  });

  it.each([{ argv: 'shell string' }, { argv: [23] }, { argv: ['a\0b'] }, { argv: Array(33).fill('a') }])('rejects invalid publication arguments', async result => {
    const bridge = new ScriptDriveBridge('/bridge', async () => reply(result), async () => {});
    await expect(bridge.reservePublish('lease', 'job')).rejects.toThrow('publication reservation');
  });

  it('releases reservations and forwards native status/transition operations', async () => {
    const command = vi.fn(async (_exe: string, args: string[]) => reply(args[0] === 'reserve-publish' ? { argv: [] } : true));
    const bridge = new ScriptDriveBridge('/bridge', command, async () => {});
    await bridge.reservePublish('lease', 'job');
    await bridge.finishPublish('lease', 'job', 'unknown');
    expect(JSON.parse(command.mock.calls.at(-1)![1][1]!)).toEqual({ protocol: 'phm-drive/v1', lease: 'lease', job: 'job', outcome: 'unknown' });
    await bridge.reservePublish('lease', 'job');
    await bridge.release('lease');
    await expect(bridge.publish('/owned/publish.sh', 'job', 'lease')).rejects.toThrow('no durable reservation');
  });
});

describe('drive CLI', () => {
  it('defaults to 30 seconds and supports explicit bridge paths', () => {
    expect(parseDriveOptions([], '/home/test')).toEqual({ once: false, dryRun: false, tickMs: 30_000,
      bridge: '/home/test/.ashlr-runs/queue/drive-bridge', publisher: '/home/test/.ashlr-runs/queue/publish.sh', pauseFile: '/home/test/.ashlr-runs/PAUSE' });
    expect(parseDriveOptions(['--once', '--dry-run', '--tick', '5', '--bridge', '/bridge', '--publisher', '/publish.sh', '--pause-file', '/PAUSE']))
      .toMatchObject({ once: true, dryRun: true, tickMs: 5_000, bridge: '/bridge', publisher: '/publish.sh', pauseFile: '/PAUSE' });
  });
  it.each([['--tick', '0'], ['--tick', 'NaN'], ['--tick', '1.5'], ['--tick', '86401'], ['--tick'], ['--wat'], ['--once', '--once'], ['--bridge', 'relative']])('rejects bad arguments %j', (...args) => {
    expect(() => parseDriveOptions(args)).toThrow();
  });
  it('once dry-run is read-only and restores signal handlers', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bridge: DriveBridge = { snapshot: vi.fn(async () => structuredClone(snapshot)), acquire: vi.fn(), reap: vi.fn(),
      launch: vi.fn(), reservePublish: vi.fn(), finishPublish: vi.fn(), writeStatus: vi.fn(), release: vi.fn() };
    const publish = vi.fn();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await cmdDrive(['--once', '--dry-run'], { bridge, paused: async () => false, publish })).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ dryRun: true, planned: ['ready'] });
    expect(bridge.acquire).not.toHaveBeenCalled();
    expect(bridge.writeStatus).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
  it('uses conventional usage/error codes without echoing unsafe input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDrive(['--help'])).toBe(0);
    expect(await cmdDrive(['unsafe-input'])).toBe(2);
    expect(error.mock.calls.flat().join()).not.toContain('unsafe-input');
  });
});

describe('drive local controls', () => {
  it('recognizes PAUSE including a dangling symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drive-control-')); directories.push(root);
    const pause = join(root, 'PAUSE');
    expect(await driveControlPresent(pause)).toBe(false);
    await symlink(join(root, 'missing'), pause);
    expect(await driveControlPresent(pause)).toBe(true);
  });
  it('refuses executable aliases, directories and writable executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drive-executable-')); directories.push(root);
    // macOS /var is a symlink; canonicalize the fixture just as the CLI requires.
    const { realpath } = await import('node:fs/promises');
    const canonical = await realpath(root);
    const executable = join(canonical, 'bridge');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await expect(checkDriveExecutable(executable)).resolves.toBeUndefined();
    await chmod(executable, 0o722);
    await expect(checkDriveExecutable(executable)).rejects.toThrow();
    await chmod(executable, 0o700);
    const alias = join(canonical, 'alias');
    await symlink(executable, alias);
    await expect(checkDriveExecutable(alias)).rejects.toThrow();
    await rm(alias);
    await link(executable, alias);
    await expect(checkDriveExecutable(executable)).rejects.toThrow();
    const directory = join(canonical, 'dir'); await mkdir(directory);
    await expect(checkDriveExecutable(directory)).rejects.toThrow();
    await expect(checkDriveExecutable('relative')).rejects.toThrow('absolute');
  });
});
