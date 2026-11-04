// Desktop path end to end, server side: console request -> MASON-INBOX -> bus -> ack -> console read.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { acknowledgeInboxEntries } from '../src/core/fleet/inbox-ack.js';
import * as bus from '../src/core/fleet/bus-inbox.js';
import { INTERJECT_ACK_READ_PATH, INTERJECT_POST_PATH, buildInterjectBody, pickInboxAck } from '../src/web-ui/routes/verse/fleet/interject-request.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const TEXT = 'Fake order: prioritize the inbox bridge';
let root: string;
let runsDir: string;
let busRoot: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'desktop-interject-e2e-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  busRoot = join(root, 'ashlr', 'fleet');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const api = createFleetRunsApi;
async function call(handler: ReturnType<typeof api>, url: string, method: 'GET' | 'POST', body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-token' };
  req.method = method;
  req.url = url;
  let status = 0;
  let out = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(value: string) { out = value; } } as unknown as ServerResponse;
  await handler({ token: 'fake-token', allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}
const inboxLines = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').split('\n').filter(line => /\[src:/.test(line));
function busMessages() {
  const page = bus.listBusInboxAfter(0, 100, { root: busRoot, now: () => NOW });
  if (page.status !== 'ok') throw new Error('bus unavailable');
  return page.messages;
}

it('console order lands in the inbox and bus, and its ack reads back through the console poll', async () => {
  const handler = api({ runsDir, now: () => NOW });
  const posted = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(posted).toMatchObject({ status: 201, body: { ok: true, accepted: true } });
  const id = posted.body.id as string;

  // a. one inbox entry attributed to source desktop
  const lines = inboxLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`\\[src:desktop id:${id}\\] ${TEXT}$`));

  // b. one bus event linked to that entry (same text, same dedupe key)
  const events = busMessages();
  expect(events).toHaveLength(1);
  expect(events[0]!.envelope).toMatchObject({ from: 'mason', to: 'leaders', body: { kind: 'interjection', channel: 'desktop', text: TEXT } });
  const busKey = (events[0]!.envelope.body as { dedupeKey: string }).dedupeKey;
  expect(`sha256:${busKey.slice(0, 24)}`).toBe(posted.body.dedupeKey);

  // Before the fleet acks, the console poll sees the entry as pending.
  expect(pickInboxAck((await call(handler, INTERJECT_ACK_READ_PATH, 'GET')).body, id)).toBe('pending');

  // c. the fleet's ack writer runs; the console poll then returns the ack for that entry.
  await acknowledgeInboxEntries(lines, runsDir, '2026-11-02T12:01:00Z');
  const read = await call(handler, INTERJECT_ACK_READ_PATH, 'GET');
  expect(read.status).toBe(200);
  expect(pickInboxAck(read.body, id)).toBe('acked');
  expect(pickInboxAck(read.body, 'desk-other')).toBe('unknown');
  expect(busMessages().some(m => m.envelope.from === 'planner' && m.envelope.to === 'mason')).toBe(true);
});

it('a duplicate submit inside the dedupe window adds no second entry or bus event', async () => {
  const handler = api({ runsDir, now: () => NOW });
  await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  const again = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(again).toMatchObject({ status: 200, body: { ok: true, duplicate: true, accepted: false } });
  expect(inboxLines()).toHaveLength(1);
  expect(busMessages()).toHaveLength(1);
});
