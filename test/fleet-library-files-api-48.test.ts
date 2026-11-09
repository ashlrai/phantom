/** GET /api/verse/fleet/library-files: the Leader's working files for the Library pane. */
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFleetLibraryFilesApi, VERSE_FLEET_LIBRARY_FILES_PATH as PATH } from '../src/core/verse/fleet-library-files-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-09T12:00:00.000Z');

async function call(api: ApiModule, method = 'GET', url = PATH) {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, url, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet library files route', () => {
  it('lists files, skips symlinks, scrubs previews and returns no absolute path', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'library-files-'));
    const outside = await mkdtemp(join(tmpdir(), 'library-outside-'));
    const leader = join(runsDir, 'leader');
    await mkdir(join(leader, 'drafts'), { recursive: true });
    await writeFile(join(leader, 'VISION.md'), 'The vision. key sk-test-FAKE0000000000000000 end');
    await writeFile(join(leader, 'drafts', 'idea.md'), 'A draft idea.');
    await writeFile(join(outside, 'secret.md'), 'outside content');
    await symlink(join(outside, 'secret.md'), join(leader, 'PLAN-LOG.md'));
    await symlink(join(outside, 'secret.md'), join(leader, 'drafts', 'linked.md'));

    const r = await call(createFleetLibraryFilesApi({ runsDir, now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body.v).toBe(1);
    expect(r.body.observedAt).toBe(NOW.toISOString());
    expect(r.body.state).toBeUndefined();
    expect(r.body.files.map((f: { name: string }) => f.name).sort()).toEqual(['VISION.md', 'drafts/idea.md']);
    expect(r.text).not.toContain('sk-test-FAKE0000000000000000');
    expect(r.text).not.toContain('outside content');
    expect(r.text).not.toContain(runsDir);
    expect(r.text).not.toContain(outside);
    expect(r.text).not.toContain('linked.md');
    expect(r.body.files.find((f: { name: string }) => f.name === 'VISION.md').preview).toContain('The vision.');
  });

  it('rejects non-GET with 405', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'library-files-'));
    const r = await call(createFleetLibraryFilesApi({ runsDir }), 'POST');
    expect(r.status).toBe(405);
  });

  it('ignores other paths', async () => {
    const r = await call(createFleetLibraryFilesApi({ runsDir: tmpdir() }), 'GET', '/api/verse/other');
    expect(r.handled).toBe(false);
  });

  it('reports an absent leader directory as state absent, not as zero files', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'library-files-'));
    const r = await call(createFleetLibraryFilesApi({ runsDir, now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, observedAt: NOW.toISOString(), files: [], state: 'absent' });
  });

  it('reports a failed read as unavailable', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'library-files-'));
    await mkdir(join(runsDir, 'leader'));
    const r = await call(createFleetLibraryFilesApi({ runsDir, now: () => NOW, list: async () => { throw new Error('EIO /secret/path'); } }));
    expect(r.body).toEqual({ v: 1, observedAt: NOW.toISOString(), files: [], state: 'unavailable' });
    expect(r.text).not.toContain('/secret/path');
  });

  it('reports a leader path that is not a directory as unavailable', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'library-files-'));
    await writeFile(join(runsDir, 'leader'), 'not a dir');
    const r = await call(createFleetLibraryFilesApi({ runsDir, now: () => NOW }));
    expect(r.body.state).toBe('unavailable');
  });
});
