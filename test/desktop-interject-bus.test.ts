import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import * as bus from '../src/core/fleet/bus-inbox.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
let root: string;
let runsDir: string;
let busRoot: string;
let inboxFile: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'desktop-interject-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  busRoot = join(root, 'ashlr', 'fleet');
  inboxFile = join(runsDir, 'leader', 'MASON-INBOX.md');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function api() { return createFleetRunsApi({ runsDir, now: () => NOW }); }
async function post(handler: ReturnType<typeof api>, text = 'Steer the fleet toward the inbox bridge') {
  const req = Readable.from([JSON.stringify({ text })]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-local-operator' };
  req.method = 'POST';
  req.url = VERSE_FLEET_RUNS_INBOX_PATH;
  let status = 0;
  let body: unknown;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(value: string) { body = JSON.parse(value); },
  } as unknown as ServerResponse;
  const handled = await handler({ token: 'fake-local-operator', allowDispatch: true } as VerseApiContext,
    req, res, VERSE_FLEET_RUNS_INBOX_PATH, 'POST');
  return { handled, status, body };
}
function messages() {
  const page = bus.listBusInboxAfter(0, 100, { root: busRoot, now: () => NOW });
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') throw new Error('Bus unavailable');
  return page.messages;
}
it('POST persists the inbox and one attributed Mason interjection on the durable bus', async () => {
  const text = 'Steer the fleet toward the inbox bridge';
  expect(await post(api(), text)).toMatchObject({ handled: true, status: 201, body: { ok: true, accepted: true } });
  expect(readFileSync(inboxFile, 'utf8')).toContain(text);
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.envelope).toMatchObject({ from: 'mason', to: 'leaders',
    body: { kind: 'interjection', channel: 'desktop', text } });
});
it('reposting after an API restart leaves one inbox entry and the same bus envelope', async () => {
  await post(api());
  const original = messages();
  const inbox = readFileSync(inboxFile, 'utf8');
  expect(await post(api())).toMatchObject({ status: 200, body: { ok: true, duplicate: true } });
  expect(messages()).toEqual(original);
  expect(readFileSync(inboxFile, 'utf8')).toBe(inbox);
});
it('a throwing bus store preserves inbox acceptance and the exact HTTP response', async () => {
  const append = bus.appendBusInbox;
  const store = vi.spyOn(bus, 'appendBusInbox').mockImplementation(() => { throw new Error('fake store failure'); });
  const failed = await post(api());
  expect(store).toHaveBeenCalledOnce();
  expect(readFileSync(inboxFile, 'utf8')).toContain('Steer the fleet');
  store.mockImplementation(append);
  // Independent receipt context gives the same entry id and acceptance response.
  rmSync(runsDir, { recursive: true, force: true });
  expect(await post(api())).toEqual(failed);
  expect(failed).toMatchObject({ status: 201, body: { ok: true, accepted: true } });
});
it('refuses plainly fake secret-shaped text before touching either store', async () => {
  const store = vi.spyOn(bus, 'appendBusInbox');
  expect(await post(api(), 'sk-' + 'FAKE'.repeat(12))).toMatchObject({ status: 422,
    body: { code: 'INBOX_REFUSED', reason: 'secret-shaped' } });
  expect(existsSync(inboxFile)).toBe(false);
  expect(store).not.toHaveBeenCalled();
  expect(existsSync(join(busRoot, 'bus-inbox'))).toBe(false);
});
