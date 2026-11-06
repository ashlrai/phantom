import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

it('keeps a stdin instruction and its receipt across an agent restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inbox-command-restart-'));
  const runsDir = join(root, 'runs');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (command: ReturnType<typeof createCommsInboxCommand>, ...args: string[]) => {
    const code = await command(args);
    return { code, body: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
  };

  try {
    const instruction = 'Review the café handoff.\nContinue the shared context.';
    const first = createCommsInboxCommand({
      runsDir, stdin: Readable.from(['  Review the cafe\u0301 handoff.\r\n', 'Continue the shared context.  \n']),
    });
    const accepted = await run(first, 'post', '--file', '-', '--json');
    expect(accepted).toEqual({
      code: 0,
      body: { ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });

    const restarted = createCommsInboxCommand({ runsDir, stdin: Readable.from([instruction]) });
    const duplicate = await run(restarted, 'post', '--file', '-', '--json');
    expect(duplicate).toEqual({
      code: 0,
      body: { ok: true, ack: { channel: 'cli', status: 'duplicate', dedupeKey: accepted.body.ack.dedupeKey } },
    });

    const read = await run(restarted, 'read', '--json');
    expect(read.code).toBe(0);
    expect(read.body).toMatchObject({
      sourceState: 'healthy', entries: [{ source: 'cli', priority: 'P0', text: instruction }],
    });
    expect(read.body.entries).toHaveLength(1);
    const persisted = await readInboxEntries({ runsDir });
    expect(persisted).toEqual(read.body);
    const source = persisted.entries[0]!.source;
    expect(await run(restarted, 'read', '--source', source, '--json')).toEqual(read);
    expect((await run(restarted, 'read', '--source', 'mobile', '--json')).body.entries).toEqual([]);

    const nextInstruction = 'Check the next handoff.';
    const next = createCommsInboxCommand({ runsDir, stdin: Readable.from([nextInstruction]) });
    const nextReceipt = await run(next, 'post', '--file', '-', '--json');
    expect(nextReceipt).toEqual({
      code: 0,
      body: { ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
    expect(nextReceipt.body.ack.dedupeKey).not.toBe(accepted.body.ack.dedupeKey);
    const filtered = await run(next, 'read', '--source', source, '--json');
    expect(filtered.code).toBe(0);
    expect(filtered.body.sourceState).toBe('healthy');
    expect(filtered.body.entries.map((entry: { source: string; text: string }) => ({ source: entry.source, text: entry.text })))
      .toEqual([{ source, text: instruction }, { source, text: nextInstruction }]);
    const newest = await run(next, 'read', '--source', source, '--limit', '1', '--json');
    expect(newest.code).toBe(0);
    expect(newest.body.entries).toEqual([filtered.body.entries[1]]);
  } finally {
    log.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
