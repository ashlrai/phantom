import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pollGmailBridge, type GmailMessage } from '../src/core/comms/gmail-bridge.js';
import { approveDraft, listDrafts, rejectDraft } from '../src/core/cos/drafts.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const message = (id: string): GmailMessage => ({
  id, from: 'person@example.test', subject: 'Hello', body: 'Hello', autoSubmitted: 'no',
});
const dependencies = (runsDir: string, messages: GmailMessage[], composeReply: (message: GmailMessage) => Promise<string>) => ({
  runsDir, readInbox: async () => messages, classify: async () => 'reply' as const,
  composeReply, summarizeUpdate: async () => '',
});

it('reuses the persisted source across polls and fresh dependencies, while distinguishing messages', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'gmail-replay-')); dirs.push(runsDir);
  const compose = vi.fn().mockResolvedValueOnce('First reply').mockResolvedValue('Different reply');
  const first = dependencies(runsDir, [message('one')], compose);
  expect((await pollGmailBridge(first)).drafted).toBe(1);
  expect((await pollGmailBridge(first)).drafted).toBe(0);
  expect((await pollGmailBridge(dependencies(runsDir, [message('one'), message('two')], compose))).drafted).toBe(1);
  const drafts = await listDrafts({ runsDir });
  expect(drafts).toHaveLength(2);
  expect(drafts.map(d => d.body)).toEqual(['First reply', 'Different reply']);
  expect(new Set(drafts.map(d => d.source)).size).toBe(2);
  expect(compose).toHaveBeenCalledTimes(2);
});

it.each(['approved', 'rejected'] as const)('preserves a %s decision on replay', async (status) => {
  const runsDir = await mkdtemp(join(tmpdir(), 'gmail-decision-')); dirs.push(runsDir);
  const compose = vi.fn().mockResolvedValueOnce('Original reply').mockResolvedValue('Changed reply');
  await pollGmailBridge(dependencies(runsDir, [message('one')], compose));
  const [original] = await listDrafts({ runsDir });
  if (!original) throw new Error('Missing draft');
  if (status === 'approved') await approveDraft(original.id, { runsDir });
  else await rejectDraft(original.id, { runsDir });
  const report = await pollGmailBridge(dependencies(runsDir, [message('one')], compose));
  const drafts = await listDrafts({ runsDir });
  expect(report.drafted).toBe(0);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ id: original.id, status, body: 'Original reply' });
  expect(compose).toHaveBeenCalledTimes(1);
});

it('isolates composition and draft-store failures from other messages', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'gmail-failures-')); dirs.push(runsDir);
  const compose = vi.fn(async (m: GmailMessage) => {
    if (m.id === 'bad') throw new Error('private detail');
    return 'Reply';
  });
  const report = await pollGmailBridge(dependencies(runsDir, [message('bad'), message('good')], compose));
  expect(report).toEqual({ scanned: 2, updates: [], drafted: 1, review: 0, failed: 1 });
  expect(await listDrafts({ runsDir })).toHaveLength(1);

  const blocked = await mkdtemp(join(tmpdir(), 'gmail-blocked-')); dirs.push(blocked);
  await writeFile(join(blocked, 'drafts'), 'not a directory');
  const neverCompose = vi.fn().mockResolvedValue('Reply');
  const failed = await pollGmailBridge(dependencies(blocked, [message('one'), message('two')], neverCompose));
  expect(failed).toEqual({ scanned: 2, updates: [], drafted: 0, review: 0, failed: 2 });
  expect(neverCompose).not.toHaveBeenCalled();
});
