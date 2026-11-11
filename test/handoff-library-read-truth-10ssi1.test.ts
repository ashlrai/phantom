import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { readHandoffFiles } from '../src/core/fleet/handoff-files.js';
import { createFleetHandoffsApi, VERSE_FLEET_HANDOFFS_PATH } from '../src/core/verse/fleet-handoffs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('reports absent, empty, populated, unavailable and partial reads truthfully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-truth-')); roots.push(root);
  async function call(fail?: string) {
    const readDir = (async (...args: Parameters<typeof readdir>) => {
      if (String(args[0]).endsWith(fail ?? '\0')) throw new Error('private path');
      return readdir(...args);
    }) as typeof readdir;
    const api = createFleetHandoffsApi({ runsDir: root, ...(fail ? { read: dir => readHandoffFiles(dir, readDir) } : {}) });
    let body = '';
    const res = { writeHead() { return this; }, end(text: string) { body = text; } } as unknown as ServerResponse;
    await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, VERSE_FLEET_HANDOFFS_PATH, 'GET');
    expect(body).not.toContain(root);
    expect(body).not.toContain('private path');
    return JSON.parse(body);
  }
  expect((await call()).state).toBe('absent');
  await mkdir(join(root, 'handoff', 'good'), { recursive: true });
  expect((await call()).handoffs).toEqual([]);
  await writeFile(join(root, 'handoff', 'good', 'note.md'), 'retained context');
  expect((await call()).handoffs[0].preview).toBe('retained context');
  expect((await call('handoff')).state).toBe('unavailable');
  await mkdir(join(root, 'handoff', 'bad'));
  const partial = await call('bad');
  expect(partial.state).toBe('partial');
  expect(partial.handoffs).toHaveLength(1);
});
