import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { handleVerseApi, type VerseApiContext } from '../src/core/verse/verse-api.js';

const key = Symbol.for('ashlr.build-identity.v1');
afterEach(() => { Reflect.deleteProperty(globalThis, key); });

it('serves only build-produced identity without initializing the Verse engine', async () => {
  const build = { schemaVersion: 1, packageVersion: '3.29.17', revision: 'd'.repeat(40), dirty: false, provenance: 'git' };
  Reflect.set(globalThis, key, JSON.stringify(build));
  let status = 0;
  let headers: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead(code: number, value: Record<string, string>) { status = code; headers = value; },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  // No engine/config context: metadata must remain independent of fleet I/O.
  expect(await handleVerseApi({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/version', 'GET')).toBe(true);
  expect(status).toBe(200);
  expect(headers['Cache-Control']).toBe('no-store');
  expect(JSON.parse(body)).toEqual(build);
});
