import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pollGmailBridge, type GmailMessage } from '../src/core/comms/gmail-bridge.js';
import { createDraft, listDrafts } from '../src/core/cos/drafts.js';

vi.mock('../src/core/cos/drafts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/cos/drafts.js')>();
  return { ...actual, listDrafts: vi.fn(actual.listDrafts), createDraft: vi.fn(actual.createDraft) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(listDrafts).mockReset();
  vi.mocked(createDraft).mockReset();
  const actual = await vi.importActual<typeof import('../src/core/cos/drafts.js')>('../src/core/cos/drafts.js');
  vi.mocked(listDrafts).mockImplementation(actual.listDrafts);
  vi.mocked(createDraft).mockImplementation(actual.createDraft);
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const message = (id: string): GmailMessage => ({ id, from: 'person@example.test', subject: 'Hello', body: 'Hello', autoSubmitted: 'no' });
const source = (id: string) => `gmail-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
const dependencies = (runsDir: string, messages: GmailMessage[]) => ({
  runsDir, readInbox: async () => messages, classify: async () => 'reply' as const,
  composeReply: async () => 'Reply', summarizeUpdate: async () => 'Update',
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'gmail-batch-')); dirs.push(dir); return dir;
}

it('reads once per batch, persists drafts, and observes external drafts on later polls', async () => {
  const runsDir = await directory();
  const messages = Array.from({ length: 100 }, (_, i) => message(String(i)));
  const deps = dependencies(runsDir, messages);
  expect(await pollGmailBridge(deps)).toMatchObject({ scanned: 100, drafted: 100, failed: 0 });
  expect(listDrafts).toHaveBeenCalledTimes(1);
  const actual = await vi.importActual<typeof import('../src/core/cos/drafts.js')>('../src/core/cos/drafts.js');
  expect(await actual.listDrafts({ runsDir })).toHaveLength(100);
  expect((await pollGmailBridge(deps)).drafted).toBe(0);
  expect(listDrafts).toHaveBeenCalledTimes(2);
  await actual.createDraft({ to: 'person@example.test', subject: 'External', body: 'External', source: source('external') }, runsDir);
  expect((await pollGmailBridge(dependencies(runsDir, [message('external')]))).drafted).toBe(0);
  expect(await actual.listDrafts({ runsDir })).toHaveLength(101);
});

it('does not read drafts for updates, review, or unsafe replies', async () => {
  const runsDir = await directory();
  const deps = dependencies(runsDir, [message('update'), message('review'), { ...message('auto'), autoSubmitted: 'yes' }]);
  const report = await pollGmailBridge({ ...deps, classify: async m => m.id === 'update' ? 'update' : m.id === 'review' ? 'review' : 'reply' });
  expect(report).toEqual({ scanned: 3, updates: ['Update'], drafted: 0, review: 2, failed: 0 });
  expect(listDrafts).not.toHaveBeenCalled();
});

it('does not record a failed creation and allows retry in a later poll', async () => {
  const runsDir = await directory();
  vi.mocked(createDraft).mockRejectedValueOnce(new Error('private'));
  const deps = dependencies(runsDir, [message('one'), message('two'), message('two')]);
  expect(await pollGmailBridge(deps)).toEqual({ scanned: 3, updates: [], drafted: 1, review: 1, failed: 1 });
  expect((await pollGmailBridge(deps)).drafted).toBe(1);
  expect(await listDrafts({ runsDir })).toHaveLength(2);
});

it('fails closed when the store cannot be read and recovers on a later poll', async () => {
  const runsDir = await directory();
  vi.mocked(listDrafts).mockRejectedValue(new Error('private'));
  const deps = dependencies(runsDir, [message('one'), message('two')]);
  expect(await pollGmailBridge(deps)).toMatchObject({ drafted: 0, failed: 2 });
  expect(createDraft).not.toHaveBeenCalled();
  const actual = await vi.importActual<typeof import('../src/core/cos/drafts.js')>('../src/core/cos/drafts.js');
  vi.mocked(listDrafts).mockImplementation(actual.listDrafts);
  expect(await pollGmailBridge(deps)).toMatchObject({ drafted: 2, failed: 0 });
});
