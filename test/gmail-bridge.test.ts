import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pollGmailBridge, type GmailMessage } from '../src/core/comms/gmail-bridge.js';
import { listDrafts } from '../src/core/cos/drafts.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('Gmail bridge', () => {
  it('summarizes updates and creates only local approval drafts, idempotently', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'gmail-bridge-')); dirs.push(runsDir);
    const messages: GmailMessage[] = [
      { id: '1', from: 'person@example.test', subject: 'Hello', body: 'Hello', autoSubmitted: 'no' },
      { id: '2', from: 'news@example.test', subject: 'Update', body: 'News' },
      { id: '3', from: 'robot@example.test', subject: 'Auto', body: 'Auto', autoSubmitted: 'auto-replied' },
    ];
    const deps = { runsDir, readInbox: async () => messages,
      classify: async (m: GmailMessage) => m.id === '2' ? 'update' as const : 'reply' as const,
      composeReply: async () => 'Thanks.', summarizeUpdate: async () => 'News summary' };
    expect(await pollGmailBridge(deps)).toEqual({ scanned: 3, updates: ['News summary'], drafted: 1, review: 1, failed: 0 });
    await pollGmailBridge(deps);
    expect(await listDrafts({ runsDir })).toHaveLength(1);
    expect((await listDrafts({ runsDir }))[0]?.status).toBe('pending');
  });
  it('isolates failures and refuses unbounded batches', async () => {
    const deps = { runsDir: '/unused', readInbox: async () => [{ id: '1', from: '', subject: '', body: '' }],
      classify: async () => { throw new Error('private provider detail'); },
      composeReply: async () => '', summarizeUpdate: async () => '' };
    expect((await pollGmailBridge(deps)).failed).toBe(1);
    await expect(pollGmailBridge({ ...deps, readInbox: async () => Array(101).fill({}) })).rejects.toThrow('exceeds');
  });
});
