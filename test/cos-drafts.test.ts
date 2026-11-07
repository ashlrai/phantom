import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveDraft, createDraft, draftNeedsYouItem, draftsDir, getDraft, listDrafts, needsYouItems,
  refreshDraftsNeedsYou, rejectDraft, resetDraftsNeedsYouForTest,
} from '../src/core/cos/drafts.js';
import { sendEmailOutbox, type EmailOutboxMessage } from '../src/core/comms/email-outbox.js';
import { cmdDrafts } from '../src/cli/drafts.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';

let root: string;
let runsDir: string;
let outboxDir: string;
let logs: string[];
const mason = 'mason@example.test';
const input = { to: 'Client@Example.test', subject: 'Quote', body: 'Hello, the quote is attached.', source: 'a.reply.eml' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-drafts-'));
  runsDir = join(root, 'runs'); outboxDir = join(root, 'outbox');
  mkdirSync(runsDir, { recursive: true }); mkdirSync(outboxDir, { recursive: true });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetDraftsNeedsYouForTest();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('draft store', () => {
  it('writes a private JSONL record with metadata and body', async () => {
    const d = await createDraft(input, runsDir);
    expect(d).toMatchObject({ status: 'pending', channel: 'email', to: 'client@example.test', subject: 'Quote' });
    expect(d.id).toMatch(/^d-[0-9a-f]{16}$/);
    const file = join(draftsDir(runsDir), 'drafts.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({ id: d.id, body: input.body });
  });

  it('is idempotent for the same source and content', async () => {
    const a = await createDraft(input, runsDir);
    const b = await createDraft(input, runsDir);
    expect(b.id).toBe(a.id);
    expect(await listDrafts({ runsDir })).toHaveLength(1);
  });

  it('refuses secret-shaped text without echoing it and writes nothing', async () => {
    const secret = `sk-${'a1'.repeat(15)}`;
    const err = await createDraft({ ...input, body: `key ${secret}` }, runsDir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secret);
    expect(existsSync(join(draftsDir(runsDir), 'drafts.jsonl'))).toBe(false);
  });

  it('rejects bad recipients and oversized bodies', async () => {
    await expect(createDraft({ ...input, to: 'a@x.test, b@x.test' }, runsDir)).rejects.toThrow(/one recipient/);
    await expect(createDraft({ ...input, body: 'x'.repeat(70_000) }, runsDir)).rejects.toThrow(/too large/);
  });

  it('approve and reject are one-way and approve is digest-bound', async () => {
    const a = await createDraft(input, runsDir);
    await expect(approveDraft(a.id, { runsDir, digest: '00000000' })).rejects.toThrow(/Digest/);
    await expect(approveDraft(a.id, { runsDir, digest: a.digest.slice(0, 4) })).rejects.toThrow(/Digest/);
    const ok = await approveDraft(a.id, { runsDir, digest: a.digest.slice(0, 12), now: () => new Date('2026-11-04T12:00:00Z') });
    expect(ok).toMatchObject({ status: 'approved', decidedAt: '2026-11-04T12:00:00.000Z' });
    await expect(rejectDraft(a.id, { runsDir })).rejects.toThrow(/already approved/);
    const b = await createDraft({ ...input, source: 'b.reply.eml' }, runsDir);
    expect((await rejectDraft(b.id, { runsDir })).status).toBe('rejected');
    await expect(approveDraft('d-0000000000000000', { runsDir })).rejects.toThrow(/No such draft/);
    expect(await listDrafts({ runsDir, status: 'pending' })).toHaveLength(0);
  });

  it('drops tampered and malformed lines but keeps the rest', async () => {
    const a = await createDraft(input, runsDir);
    const file = join(draftsDir(runsDir), 'drafts.jsonl');
    const forged = JSON.stringify({ ...a, id: 'd-ffffffffffffffff', to: 'evil@x.test' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${forged}\n`);
    expect((await listDrafts({ runsDir })).map((d) => d.id)).toEqual([a.id]);
    expect(await getDraft('d-ffffffffffffffff', runsDir)).toBeNull();
  });
});

describe('needs-you producer', () => {
  it('files one valid approval item per pending draft with Approve / Reject', async () => {
    const a = await createDraft(input, runsDir);
    const b = await createDraft({ ...input, source: 'b.reply.eml' }, runsDir);
    await rejectDraft(b.id, { runsDir });
    await refreshDraftsNeedsYou(runsDir);
    const items = needsYouItems();
    expect(items).toHaveLength(1);
    expect(isNeedsYouItem(items[0])).toBe(true);
    expect(items[0]!.id).toBe(`approvals:approval:draft-${a.id}`);
    expect(items[0]!.actions.map((x) => x.kind)).toEqual(['approve', 'reject']);
    expect(JSON.stringify(items[0])).not.toContain(input.body);
    expect(isNeedsYouItem(draftNeedsYouItem(a))).toBe(true);
  });
});

describe('email outbox routing', () => {
  const write = (name: string, to: string) =>
    writeFileSync(join(outboxDir, name), `To: ${to}\r\nSubject: Re: hi\r\n\r\nbody text\r\n`);
  const run = (calls: EmailOutboxMessage[], draftsRunsDir?: string) => sendEmailOutbox({
    dir: outboxDir, allowedRecipients: new Set([mason]), draftsRunsDir,
    transport: async (m) => { calls.push(m); return { ok: true }; },
    policyCheck: () => ({ decision: 'allow', reason: 'test-allow' }),   // transport path; the pending-review stub stays production default
  });

  it('sends Mason directly and drafts everyone else without sending', async () => {
    write('1-mason.reply.eml', mason);
    write('2-client.reply.eml', 'client@example.test');
    const calls: EmailOutboxMessage[] = [];
    const result = await run(calls, runsDir);
    expect(result).toMatchObject({ sent: 1, drafted: 1, refused: 0 });
    expect(calls.map((c) => c.to)).toEqual([mason]);
    const detail = result.details.find((d) => d.outcome === 'drafted')!;
    expect(detail.draftId).toMatch(/^d-/);
    expect(readdirSync(join(outboxDir, 'drafted'))).toEqual(['2-client.reply.eml']);
    expect(await listDrafts({ runsDir })).toMatchObject([
      { id: detail.draftId, to: 'client@example.test', status: 'pending', body: 'body text\r\n' },
    ]);
  });

  it('never sends after approval: approve only records', async () => {
    write('2-client.reply.eml', 'client@example.test');
    const calls: EmailOutboxMessage[] = [];
    const { details } = await run(calls, runsDir);
    await approveDraft(details[0]!.draftId!, { runsDir });
    await run(calls, runsDir);
    expect(calls).toHaveLength(0);
  });

  it('keeps the old refuse behaviour when no drafts dir is given', async () => {
    write('2-client.reply.eml', 'client@example.test');
    const calls: EmailOutboxMessage[] = [];
    expect(await run(calls)).toMatchObject({ drafted: 0, refused: 1 });
    expect(existsSync(join(outboxDir, '2-client.reply.eml'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses multi-recipient mail instead of drafting it, and a secret-shaped reply stays put', async () => {
    write('3-two.reply.eml', 'a@example.test, b@example.test');
    writeFileSync(join(outboxDir, '4-secret.reply.eml'), `To: c@example.test\r\nSubject: s\r\n\r\nsk-${'a1'.repeat(15)}\r\n`);
    const calls: EmailOutboxMessage[] = [];
    const result = await run(calls, runsDir);
    expect(result).toMatchObject({ drafted: 0, refused: 2, sent: 0 });
    expect(result.details.map((d) => d.reason)).toEqual(['multiple-recipients', 'draft-refused']);
    expect(await listDrafts({ runsDir })).toHaveLength(0);
  });

  it('a reappearing file does not duplicate its draft', async () => {
    write('2-client.reply.eml', 'client@example.test');
    await run([], runsDir);
    write('2-client.reply.eml', 'client@example.test');
    await run([], runsDir);
    expect(await listDrafts({ runsDir })).toHaveLength(1);
  });
});

describe('phm drafts', () => {
  it('lists without bodies, shows with the body, approves and rejects with --json', async () => {
    const a = await createDraft(input, runsDir);
    const b = await createDraft({ ...input, source: 'b.reply.eml' }, runsDir);
    expect(await cmdDrafts(['list', '--json'], { runsDir })).toBe(0);
    const listed = JSON.parse(logs.pop()!);
    expect(listed.drafts).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(input.body);
    expect(await cmdDrafts(['show', a.id, '--json'], { runsDir })).toBe(0);
    expect(JSON.parse(logs.pop()!).draft.body).toBe(input.body);
    expect(await cmdDrafts(['approve', a.id, '--digest', a.digest.slice(0, 10), '--json'], { runsDir })).toBe(0);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ ok: true, sent: false, draft: { status: 'approved' } });
    expect(await cmdDrafts(['reject', b.id, '--json'], { runsDir })).toBe(0);
    expect(await cmdDrafts(['list', '--status', 'pending', '--json'], { runsDir })).toBe(0);
    expect(JSON.parse(logs.pop()!).drafts).toEqual([]);
  });

  it('exits 1 for unknown or decided drafts and 2 for bad usage', async () => {
    const a = await createDraft(input, runsDir);
    expect(await cmdDrafts(['show', 'd-0000000000000000', '--json'], { runsDir })).toBe(1);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ ok: false });
    await cmdDrafts(['reject', a.id], { runsDir });
    expect(await cmdDrafts(['approve', a.id, '--json'], { runsDir })).toBe(1);
    expect(await cmdDrafts(['approve', '--json'], { runsDir })).toBe(2);
    expect(await cmdDrafts(['list', '--status', 'bogus'], { runsDir })).toBe(2);
    expect(await cmdDrafts(['show', a.id, '--digest', 'abc'], { runsDir })).toBe(2);
    expect(await cmdDrafts(['nope'], { runsDir })).toBe(2);
    expect(await cmdDrafts(['--help'], { runsDir })).toBe(0);
  });
});
