/** listHandoffFiles + GET /api/verse/fleet/handoffs: the agent handoff folders
 * for the Library pane. Tmp dirs and plainly fake content only. */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { listHandoffFiles } from '../src/core/fleet/handoff-files.js';
import { createFleetHandoffsApi, VERSE_FLEET_HANDOFFS_PATH as PATH } from '../src/core/verse/fleet-handoffs-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-handoffs-'));
  roots.push(dir);
  return dir;
}

async function call(api: ApiModule, method = 'GET', url = PATH, allowDispatch = true) {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, url, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('listHandoffFiles', () => {
  it('lists .md files from two folders with folder, name, size, ISO modifiedAt and a bounded preview', async () => {
    const root = await tmp();
    await mkdir(join(root, 'handoff', 'inbox'), { recursive: true });
    await mkdir(join(root, 'handoff', 'outbox'), { recursive: true });
    await writeFile(join(root, 'handoff', 'inbox', 'note-a.md'), 'First   handoff\nwith   whitespace');
    await writeFile(join(root, 'handoff', 'outbox', 'note-b.md'), 'Second handoff');
    const rows = await listHandoffFiles(root);
    expect(rows.map(row => `${row.folder}/${row.name}`).sort()).toEqual(['inbox/note-a.md', 'outbox/note-b.md']);
    for (const row of rows) {
      expect(row.size).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row.modifiedAt))).toBe(false);
      expect(row.preview.length).toBeLessThanOrEqual(240);
    }
    expect(rows.find(row => row.name === 'note-a.md')?.preview).toBe('First handoff with whitespace');
    expect(JSON.stringify(rows)).not.toContain(root);
  });

  it('skips a symlinked file, a symlinked folder, an oversize file, a non-md file and a bad folder name', async () => {
    const root = await tmp();
    const outside = await tmp();
    await mkdir(join(root, 'handoff', 'inbox'), { recursive: true });
    await mkdir(join(root, 'handoff', 'Bad_Name'), { recursive: true });
    await mkdir(join(outside, 'real'), { recursive: true });
    await writeFile(join(root, 'handoff', 'inbox', 'ok.md'), 'kept');
    await writeFile(join(root, 'handoff', 'inbox', 'notes.txt'), 'dropped');
    await writeFile(join(root, 'handoff', 'inbox', 'big.md'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(root, 'handoff', 'Bad_Name', 'inner.md'), 'dropped');
    await writeFile(join(outside, 'real', 'far.md'), 'dropped');
    await writeFile(join(outside, 'outside.md'), 'dropped');
    await symlink(join(outside, 'outside.md'), join(root, 'handoff', 'inbox', 'linked.md'));
    await symlink(join(outside, 'real'), join(root, 'handoff', 'linked-dir'));
    const rows = await listHandoffFiles(root);
    expect(rows.map(row => `${row.folder}/${row.name}`)).toEqual(['inbox/ok.md']);
  });

  it('takes at most 200 files per folder, newest mtime first', async () => {
    const root = await tmp();
    const inbox = join(root, 'handoff', 'inbox');
    await mkdir(inbox, { recursive: true });
    const base = new Date('2026-11-01T00:00:00.000Z');
    for (let i = 0; i < 205; i += 1) {
      const name = join(inbox, `f${String(i).padStart(3, '0')}.md`);
      await writeFile(name, `file ${i}`);
      const at = new Date(base.getTime() + i * 1000);
      await utimes(name, at, at);
    }
    const rows = await listHandoffFiles(root);
    expect(rows).toHaveLength(200);
    // The five oldest lose the cap; f204 is newest and sorts first.
    expect(rows.map(row => row.name)).not.toContain('f000.md');
    expect(rows.map(row => row.name)).not.toContain('f004.md');
    expect(rows[0].name).toBe('f204.md');
    expect(rows[199].name).toBe('f005.md');
  });

  it('scrubs a secret-shaped string from the preview', async () => {
    const root = await tmp();
    await mkdir(join(root, 'handoff', 'inbox'), { recursive: true });
    const secret = 'sk-test-FAKE0000000000000000';
    await writeFile(join(root, 'handoff', 'inbox', 'leak.md'), `handoff for you ${secret} end`);
    const rows = await listHandoffFiles(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toContain('[REDACTED]');
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('returns an empty list when the handoff directory is missing', async () => {
    expect(await listHandoffFiles(await tmp())).toEqual([]);
  });
});

describe('GET /api/verse/fleet/handoffs', () => {
  it('returns v 1, observedAt and the handoffs when the directory is present', async () => {
    const root = await tmp();
    await mkdir(join(root, 'handoff', 'inbox'), { recursive: true });
    await writeFile(join(root, 'handoff', 'inbox', 'hello.md'), 'a handoff note');
    const r = await call(createFleetHandoffsApi({ runsDir: root, now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body.v).toBe(1);
    expect(r.body.observedAt).toBe(NOW.toISOString());
    expect(r.body.state).toBeUndefined();
    expect(r.body.handoffs).toHaveLength(1);
    expect(r.body.handoffs[0]).toMatchObject({ folder: 'inbox', name: 'hello.md', size: 'a handoff note'.length, preview: 'a handoff note' });
    expect(Number.isNaN(Date.parse(r.body.handoffs[0].modifiedAt))).toBe(false);
    expect(r.text).not.toContain(root);
  });

  it('reports a missing handoff directory as state absent, not zero handoffs', async () => {
    const r = await call(createFleetHandoffsApi({ runsDir: await tmp(), now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, observedAt: NOW.toISOString(), handoffs: [], state: 'absent' });
  });

  it('reports a failed read as unavailable with an empty list', async () => {
    const root = await tmp();
    await mkdir(join(root, 'handoff'));
    const r = await call(createFleetHandoffsApi({ runsDir: root, now: () => NOW, list: async () => { throw new Error('EIO /secret/path'); } }));
    expect(r.body).toEqual({ v: 1, observedAt: NOW.toISOString(), handoffs: [], state: 'unavailable' });
    expect(r.text).not.toContain('/secret/path');
  });

  it('404s without dispatch', async () => {
    const r = await call(createFleetHandoffsApi({ runsDir: await tmp() }), 'GET', PATH, false);
    expect(r.status).toBe(404);
    expect(r.handled).toBe(true);
  });

  it('405s on POST', async () => {
    const r = await call(createFleetHandoffsApi({ runsDir: await tmp() }), 'POST');
    expect(r.status).toBe(405);
  });

  it('ignores other paths', async () => {
    const r = await call(createFleetHandoffsApi({ runsDir: await tmp() }), 'GET', '/api/verse/other');
    expect(r.handled).toBe(false);
  });
});
