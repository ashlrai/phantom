import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { rememberEmailPair } from '../src/core/fleet/operator-glance-read.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { awaitNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer-await.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const mason = 'mason@example.test';
const question = 'Which fake color should the agent use?';
let root: string;
let previousHome: string | undefined;
const mail = (body: string, id: string, from = mason): string => [
  `From: ${from}`, 'To: phantom@example.test', 'Subject: Phantom needs',
  `Message-ID: <${id}@example.test>`,
  'Authentication-Results: mx.example.test; dkim=pass header.d=example.test', '', body,
].join('\r\n');
const options = () => ({
  runsDir: root, busRoot: join(root, 'bus'), outboxDir: join(root, 'outbox'),
  allowedSenders: new Set([mason]), now: () => new Date(),
});
const replies = () => readdirSync(join(root, 'outbox')).map(name =>
  readFileSync(join(root, 'outbox', name), 'utf8'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-email-roundtrip-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = root;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  rememberEmailPair(mason, root);
  // fleet needs is a reader, not an ask writer: agents currently record the
  // ledger themselves. Keep this fixture honest rather than mock an ask API.
  writeFileSync(join(root, 'NEEDS-MASON.md'), `# Needs Mason\n- [ ] ${question}\n`);
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(root, { recursive: true, force: true });
});

it('emails the real needs listing and returns one emailed answer to an already waiting agent', async () => {
  const id = listNeedsMason({ runsDir: root })[0]!.id;
  // The real drop bridge queues RFC mail. The test mail transport consumes it
  // into memory; no SMTP or network and no substitute resolver/reader.
  expect(await recordEmailToInbox(mail('/needs', 'question'), options()))
    .toMatchObject({ reason: 'status-queued' });
  const delivered = replies();
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain(`To: ${mason}`);
  expect(delivered[0]).toContain(`${id}: ${question}`);

  let settled = false;
  const waiting = awaitNeedsMasonAnswer(id, {
    root: join(root, 'bus'), timeoutMs: 1000, pollMs: 10,
  }, { now: () => Date.now() }).then(result => { settled = true; return result; });
  await Promise.resolve();
  expect(settled).toBe(false);
  const answer = mail(`/resolve ${id} Use blue.`, 'answer');
  expect(await recordEmailToInbox(answer, options())).toMatchObject({ reason: 'status-queued' });
  expect(await recordEmailToInbox(answer, options())).toMatchObject({ reason: 'status-duplicate' });
  await vi.advanceTimersByTimeAsync(10);
  expect(await waiting).toMatchObject({
    status: 'found', answer: { itemId: id, item: question, reply: 'Use blue.', source: 'email' },
  });
  expect(listNeedsMason({ runsDir: root })).toEqual([]);
  const page = listBusInboxAfter(0, 100, { root: join(root, 'bus') });
  expect(page.status).toBe('ok');
  if (page.status === 'ok') expect(page.messages.filter(row =>
    row.envelope.id === `needs-mason-resolved-${id}`)).toHaveLength(1);
  expect(readFileSync(join(root, 'leader', 'MASON-INBOX.md'), 'utf8').match(/Use blue\./g)).toHaveLength(1);
  expect(replies()).toHaveLength(2);
});

it('refuses a different sender without resolving the waiting ask', async () => {
  const id = listNeedsMason({ runsDir: root })[0]!.id;
  const waiting = awaitNeedsMasonAnswer(id, {
    root: join(root, 'bus'), timeoutMs: 20, pollMs: 10,
  }, { now: () => Date.now() });
  expect(await recordEmailToInbox(mail(`/resolve ${id} Use red.`, 'intruder', 'other@example.test'), options()))
    .toEqual({ ok: false, reason: 'sender-not-allowed' });
  expect(readNeedsMasonAnswer(id, { root: join(root, 'bus') })).toEqual({ status: 'unknown' });
  await vi.advanceTimersByTimeAsync(20);
  expect(await waiting).toEqual({ status: 'timeout' });
  expect(listNeedsMason({ runsDir: root })).toEqual([{ id, text: question }]);
});
