import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  queueStatusPath,
  queueStatusShapeMessage,
  readQueueStatus,
  readQueueStatusView,
} from '../src/core/fleet/queue-status-read.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runsDir() {
  const dir = await mkdtemp(join(tmpdir(), 'queue-status-read-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  return dir;
}

const enoent = async () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };

describe('queueStatusPath', () => {
  it('defaults to ~/.ashlr-runs and honors an explicit runs dir', () => {
    expect(queueStatusPath()).toBe(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
    expect(queueStatusPath('/tmp/runs')).toBe(join('/tmp/runs', 'queue', 'status.json'));
  });
});

describe('readQueueStatus', () => {
  it('returns the parsed document and the path it read', async () => {
    const dir = await runsDir();
    const doc = { admission: { cap: 2, running: 1 }, lanes: {} };
    await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify(doc));
    const read = await readQueueStatus({ runsDir: dir });
    expect(read).toEqual({ ok: true, path: join(dir, 'queue', 'status.json'), value: doc });
  });

  it('reports a missing file with the path and the two ways forward', async () => {
    const dir = await runsDir();
    const read = await readQueueStatus({ runsDir: dir, subject: 'phm fleet starved' });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe('missing');
    expect(read.message).toBe(
      `No dispatcher status at ${join(dir, 'queue', 'status.json')}: this machine has no fleet publishing queue/status.json. `
      + 'phm fleet starved reads the local dispatcher\'s live state — run it on a node running the fleet, '
      + 'or set ASHLR_RUNS_DIR to a runs root that has one.');
  });

  it('distinguishes an unreadable file from a missing one', async () => {
    const read = await readQueueStatus({
      read: async () => { throw new Error('EACCES'); },
      runsDir: '/runs',
      subject: 'phm fleet trim',
    });
    expect(read).toEqual({
      ok: false, path: join('/runs', 'queue', 'status.json'), kind: 'unreadable',
      message: `Cannot read queue status: ${join('/runs', 'queue', 'status.json')} exists but cannot be read.`,
    });
    // A plain ENOENT-looking message without the errno code is not proof of absence.
    const plain = await readQueueStatus({ read: async () => { throw new Error('ENOENT'); }, runsDir: '/runs' });
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.kind).toBe('unreadable');
  });

  it('reports bad JSON separately from a missing file', async () => {
    const read = await readQueueStatus({ read: async () => 'not json', runsDir: '/runs' });
    expect(read).toEqual({
      ok: false, path: join('/runs', 'queue', 'status.json'), kind: 'invalid-json',
      message: `Cannot read queue status: ${join('/runs', 'queue', 'status.json')} is not valid JSON.`,
    });
  });

  it('honors ASHLR_RUNS_DIR for the default runs root', async () => {
    const dir = await runsDir();
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const reader = vi.fn(async () => '{}');
    await readQueueStatus({ read: reader });
    expect(reader).toHaveBeenCalledExactlyOnceWith(join(dir, 'queue', 'status.json'));
  });

  it('ignores a relative ASHLR_RUNS_DIR like runsRoot does', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', 'relative/runs');
    const reader = vi.fn(async () => '{}');
    await readQueueStatus({ read: reader });
    expect(reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  });
});

describe('readQueueStatusView', () => {
  it('projects a good read and returns the view', async () => {
    const result = await readQueueStatusView(
      value => ({ lanes: Object.keys((value as { lanes?: object }).lanes ?? {}) }),
      { read: async () => JSON.stringify({ lanes: { codex: {} } }), runsDir: '/runs' },
    );
    expect(result).toEqual({ ok: true, view: { lanes: ['codex'] } });
  });

  it('maps a projector throw to the invalid-document message with the read path', async () => {
    const result = await readQueueStatusView(
      () => { throw new Error('Invalid count'); },
      { read: async () => '{}', runsDir: '/runs' },
    );
    expect(result).toEqual({ ok: false, message: queueStatusShapeMessage(join('/runs', 'queue', 'status.json')) });
  });

  it('passes read failures through without calling the projector', async () => {
    const project = vi.fn();
    const result = await readQueueStatusView(project, { read: enoent, runsDir: '/runs' });
    expect(result.ok).toBe(false);
    expect(project).not.toHaveBeenCalled();
    if (!result.ok) expect(result.message).toContain('No dispatcher status at');
  });

  it('awaits an async projector', async () => {
    const result = await readQueueStatusView(
      async value => `seen ${(value as { n: number }).n}`,
      { read: async () => '{"n":3}', runsDir: '/runs' },
    );
    expect(result).toEqual({ ok: true, view: 'seen 3' });
  });
});
