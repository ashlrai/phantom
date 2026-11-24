/** Recut #5767: owner-thread receipt visibility follows the returned message window. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, postOwnerNotice, readOwnerThread, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { recordDelivery } from '../src/core/leader/delivery-receipts.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'recut-verse-c533-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('returns receipts only for outbound messages in the requested window without changing stored evidence', async () => {
  const settings = {
    ...emptyOwnerSettings(), confirmed: true, owners: { desktop: 'fake-local-owner' },
    team: [{ channel: 'bus' as const, id: 'fake-local-owner' }],
  };
  const options: OwnerThreadOptions = {
    runsDir: root, busRoot: join(root, 'bus'), settings, halted: false, paused: false,
    now: () => Date.UTC(2026, 10, 17),
    mailbox: { async accept() { return { status: 'accepted', requestId: 'fake-request' }; } },
  };
  for (const id of ['fake-old-notice', 'fake-visible-notice']) {
    expect((await postOwnerNotice({ text: id, idempotencyKey: id }, options)).status).toBe('accepted');
  }
  expect((await acceptOwnerInbound({
    channel: 'desktop', senderId: 'fake-local-owner', text: 'Fake inbound message',
    idempotencyKey: 'fake-inbound-message', at: options.now!(),
  }, options)).status).toBe('accepted');
  const [old, visible, inbound] = readOwnerThread(options).messages;
  expect([old?.direction, visible?.direction, inbound?.direction]).toEqual(['outbound', 'outbound', 'inbound']);
  recordDelivery(root, old!.id, 'desktop', 'delivered');
  recordDelivery(root, visible!.id, 'desktop', 'pending');
  recordDelivery(root, visible!.id, 'desktop', 'failed', 'Fake delivery refused');
  recordDelivery(root, inbound!.id, 'desktop', 'delivered');
  recordDelivery(root, 'fake-orphan-message', 'desktop', 'delivered');
  const files = ['owner-thread.json', 'delivery-receipts.jsonl'].map(file => join(root, 'leader', file));
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));

  let status = 0;
  let body: { messages: { id: string }[]; receipts: Record<string, unknown> } | undefined;
  const req = Object.assign(new PassThrough(), {
    url: `${VERSE_OWNER_THREAD_PATH}?limit=2`, method: 'GET',
  }) as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { body = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await createOwnerThreadApi({ ...options, configDir: join(root, 'config') })(
    { cfg: {}, allowDispatch: true } as VerseApiContext, req, res, VERSE_OWNER_THREAD_PATH, 'GET',
  );

  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(body?.messages.map(message => message.id)).toEqual([visible!.id, inbound!.id]);
  expect(body?.receipts).toEqual({
    [visible!.id]: { desktop: { state: 'failed', reason: 'Fake delivery refused' } },
  });
  expect(await Promise.all(files.map(file => readFile(file, 'utf8')))).toEqual(before);
});
