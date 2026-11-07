import { expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function snapshot(readHostLoad: () => unknown) {
  const fail = async () => { throw new Error('unavailable'); };
  const api = createFleetRunsApi({ readHostLoad, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour: fail });
  let body = '';
  const res = { writeHead() {}, end(text: string) { body = text; } } as unknown as ServerResponse;
  await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_RUNS_PATH, 'GET');
  return JSON.parse(body) as Record<string, unknown>;
}

it('projects injected host load independently of degraded sources', async () => {
  const host = { load1: 194, load5: 180, load15: 160, cores: 18, ratio: 10.8 };
  expect(await snapshot(() => ({ ...host, extra: 'private' }))).toMatchObject({ host, sources: { runsDir: 'degraded' } });
  expect((await snapshot(() => ({ ...host, extra: 'private' }))).host).toEqual(host);
});
it('leaves host null when the reader throws or returns malformed values', async () => {
  expect((await snapshot(() => { throw new Error('unavailable'); })).host).toBeNull();
  expect((await snapshot(() => ({ load1: Infinity }))).host).toBeNull();
});
