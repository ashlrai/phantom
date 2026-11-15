import { describe, expect, it, vi } from 'vitest';
import { readWbLocus } from '../src/core/workbench/locus.js';
import { cmdWb } from '../src/cli/wb.js';
import { handleWbApi } from '../src/core/web/wb-read-api.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../src/core/types.js';

const feed = (state: string, ok: boolean, extra: object = {}) => JSON.stringify({
  schema: 'locus.fleet_feed.v1', kind: 'locus_session', state, session_ok: ok, ...extra,
});

describe('workbench Locus custody', () => {
  it.each([['pinned', true], ['unpinned', false], ['unhealthy', false]] as const)(
    'projects the %s fixture', async (state, ok) => {
      expect(await readWbLocus(async () => feed(state, ok))).toEqual({
        v: 1, state: 'ok', reason: null, custody: state, sessionOk: ok,
      });
    },
  );
  it('reports missing CLI and unsupported subcommand as unavailable', async () => {
    expect(await readWbLocus(async () => { throw new Error('ENOENT'); })).toMatchObject({ state: 'unknown', reason: 'unavailable' });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent';
      expect(await readWbLocus()).toMatchObject({ state: 'unknown', reason: 'unavailable' });
    } finally { process.env.PATH = oldPath; }
  });
  it('rejects malformed and inconsistent feeds', async () => {
    for (const value of ['{', '{}', feed('pinned', false), feed('future', false)]) {
      expect(await readWbLocus(async () => value)).toMatchObject({ state: 'unknown', reason: 'invalid' });
    }
  });
  it('discards secret-shaped fields without rendering or logging them', async () => {
    const secret = ['sk', '-FAKE', '-wbProbe', 'Secret9', '0123456789', 'abcdef'].join('');
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const result = await readWbLocus(async () => feed('pinned', true, { detail: secret }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain(secret);
    log.mockRestore(); err.mockRestore();
  });
  it('returns the same reading from CLI and HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-locus-'));
    const oldPath = process.env.PATH;
    const secret = ['sk', '-FAKE', '-wbProbe', 'Secret9', '0123456789', 'abcdef'].join('');
    writeFileSync(join(dir, 'locus'), `#!/bin/sh\nprintf '%s' '${feed('pinned', true, { detail: secret })}'\n`, { mode: 0o755 });
    process.env.PATH = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let body = '';
    const res = { writeHead: vi.fn(), end: (data: string) => { body = data; } } as unknown as ServerResponse;
    try {
      await cmdWb(['locus', '--json']);
      await handleWbApi({ method: 'GET' } as IncomingMessage, res, {} as AshlrConfig, '/api/wb/v1/locus');
      expect(JSON.parse(body)).toEqual(JSON.parse(String(log.mock.calls[0]?.[0])));
      expect(body).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true });
    }
  });
});
