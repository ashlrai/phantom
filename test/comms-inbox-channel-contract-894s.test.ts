import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readUnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { parseUnifiedInboxQuery } from '../src/core/comms/unified-inbox-query.js';
import { parseFleetCommsInboxArgs, readFleetCommsInbox } from '../src/mcp/fleet-comms-inbox.js';

it('parses and composes channel filters through the MCP inbox handler', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-contract-894-'));
  try {
    const opts = { runsDir: join(root, 'runs'), busRoot: join(root, 'bus') };
    for (const [id, to] of [['one', 'group:eng:general'], ['two', 'group:ops:alerts']]) {
      expect(appendBusInbox({ id: id!, from: 'agent:peer', to: to!, priority: 'P2', ttl: 60000,
        body: { kind: 'work', text: `synthetic ${id}` } }, { root: opts.busRoot }).status).toBe('posted');
    }
    expect(parseUnifiedInboxQuery(new URLSearchParams('channel=eng&source=bus&contains=one')))
      .toMatchObject({ ok: true, query: { filter: { channel: 'eng', source: 'bus', contains: 'one' } } });
    expect(parseUnifiedInboxQuery(new URLSearchParams('channel=Bad')).ok).toBe(false);
    expect(parseFleetCommsInboxArgs({ channel: 'bad name' })).toBeNull();
    const read = (args: Record<string, unknown>) => readFleetCommsInbox(parseFleetCommsInboxArgs(args)!,
      { runsDir: opts.runsDir, read: options => readUnifiedInbox({ ...options, busRoot: opts.busRoot }) });
    const matching = await read({ channel: 'eng', source: 'bus', contains: 'one' });
    expect(matching.items.map(item => item.id)).toEqual(['bus:one']);
    expect((await read({ channel: 'ops', source: 'bus', contains: 'one' })).items).toEqual([]);
    expect((await read({ channel: 'eng', source: 'mailbox', contains: 'one' })).items).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
