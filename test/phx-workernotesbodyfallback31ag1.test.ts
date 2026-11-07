import { lstat, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const job = 'RQ-FAKE-HANDOFF';
let runsDir: string;
const path = (suffix: string) => join(runsDir, `${job}.${suffix}`);

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-handoff-')); });
afterEach(async () => {
  vi.mocked(lstat).mockClear();
  vi.mocked(open).mockClear();
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

describe('retained worker body as notes', () => {
  it('projects a published body through the actual job detail and CLI readers', async () => {
    await writeFile(path('publish'), 'RESULT PR https://github.com/example/fake/pull/123\n');
    await writeFile(path('body.md'), '# Fake handoff\nCompleted the example.\n');
    const readers = {
      detail: (id: string) => getFleetJobDetail(id, { runsDir }),
      changes: getFleetJobChanges,
      text: (id: string, kind: 'notes' | 'prompt') => getFleetJobText(id, kind, { runsDir }),
    };
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await cmdFleetJobRead([job, '--json'], readers)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      job, state: 'published', notes: { hasNotes: false, hasBody: true, notesBytes: null },
    });
    expect(await cmdFleetJobRead([job, '--notes', '--json'], readers)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[1]?.[0]))).toMatchObject({
      job, kind: 'notes', state: 'ok', source: 'body',
      bytes: Buffer.byteLength('# Fake handoff\nCompleted the example.\n'),
      truncated: false, text: '# Fake handoff\nCompleted the example.\n',
    });
  });

  it.each(['Primary notes', ''])('prefers the primary even when its content is %j', async content => {
    await writeFile(path('notes.md'), content);
    await writeFile(path('body.md'), 'Fake body');
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'ok', source: 'notes', bytes: Buffer.byteLength(content), truncated: false, text: content,
    });
  });

  it('refuses a symlink or non-file primary despite an available body', async () => {
    await writeFile(path('body.md'), 'Fake body');
    await symlink(path('body.md'), path('notes.md'));
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'unreadable', source: null, text: '',
    });
    await rm(path('notes.md'));
    await mkdir(path('notes.md'));
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'unreadable', source: null, text: '',
    });
  });

  it('does not fall back on a primary access error', async () => {
    await writeFile(path('body.md'), 'Fake body');
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('fake access denied'), { code: 'EACCES' }));
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'unreadable', source: null, bytes: null, text: '',
    });
    expect(vi.mocked(lstat)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lstat).mock.calls[0]?.[0]).toBe(path('notes.md'));
  });

  it('does not fall back if the primary disappears between inspection and open', async () => {
    await writeFile(path('notes.md'), 'Fake notes');
    await writeFile(path('body.md'), 'Fake body');
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('fake missing file'), { code: 'ENOENT' }));
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'missing', source: null, bytes: null, text: '',
    });
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(open).mock.calls[0]?.[0]).toBe(path('notes.md'));
  });

  it('reports both missing and refuses a symlink fallback', async () => {
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'missing', source: null, bytes: null, truncated: false, text: '',
    });
    await writeFile(join(runsDir, 'fake-target'), 'Fake target');
    await symlink(join(runsDir, 'fake-target'), path('body.md'));
    expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({
      state: 'unreadable', source: null, text: '',
    });
  });

  it('applies the same byte cap and scrubbing to either source, including partial UTF-8', async () => {
    const content = `Safe\ntoken=fake-value\nkey=fake\nBearer fake\n${'FAKE_'.repeat(10)}\né漢 end`;
    const cap = Buffer.byteLength(content.slice(0, content.indexOf('漢'))) + 1;
    await writeFile(path('body.md'), content);
    const body = await getFleetJobText(job, 'notes', { runsDir, maxBytes: cap });
    await writeFile(path('notes.md'), content);
    const notes = await getFleetJobText(job, 'notes', { runsDir, maxBytes: cap });
    expect(body).toMatchObject({
      state: 'ok', source: 'body', bytes: Buffer.byteLength(content), truncated: true,
      text: 'Safe\ntoken=…\nkey=…\nBearer …\n…\né�',
    });
    expect(notes).toEqual({ ...body, source: 'notes' });
  });

  it('keeps prompt reads exact and never uses the body', async () => {
    await writeFile(path('body.md'), 'Fake body');
    expect(await getFleetJobText(job, 'prompt', { runsDir })).toMatchObject({
      state: 'missing', source: null, bytes: null, text: '',
    });
    await writeFile(path('prompt'), 'Fake prompt');
    expect(await getFleetJobText(job, 'prompt', { runsDir })).toMatchObject({
      state: 'ok', source: null, text: 'Fake prompt',
    });
  });
});
