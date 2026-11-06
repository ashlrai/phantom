import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { readInboxAckStates } from '../src/core/fleet/inbox-ack-state.js';

it('exposes real ack states on both reads and the persisted id on POST', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'inbox-ack-api-'));
  const path = '/api/verse/fleet/runs';
  try {
    await mkdir(join(runsDir, 'leader'));
    await mkdir(join(runsDir, 'queue'));
    const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
    await writeFile(inboxPath, '## 2026-11-01 00:08 ET (Mason, terminal) PRIORITY P0\nLegacy request\n' +
      '2026-11-02T05:00:00Z [src:desktop id:desk-first] First request\n' +
      '2026-11-02T05:01:00.123Z [src:desktop id:desk-second] Second request\n');
    const ledger = join(runsDir, 'queue', 'inbox-acks.jsonl');
    await writeFile(ledger, 'bad row\n' + JSON.stringify({ entryId: 'desk-first', status: 'acked' }) + '\n' +
      JSON.stringify({ entryId: 'desk-first', status: 'skipped' }) + '\n');
    const unavailable = async () => { throw new Error('unavailable'); };
    const api = createFleetRunsApi({ runsDir, readRunsDir: unavailable, listWorkers: unavailable,
      readHostLoad: () => null, codexPersonal: unavailable, mergedLastHour: unavailable });
    async function request(url: string, text?: string) {
      const method = text === undefined ? 'GET' : 'POST';
      const req = Readable.from(text === undefined ? [] : [JSON.stringify({ text })]) as unknown as IncomingMessage;
      req.url = url;
      req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'inbox-test-token' };
      let status = 0;
      let body = '';
      const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
      await api({ token: 'inbox-test-token', allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method);
      return { status, body: JSON.parse(body) };
    }
    for (const url of [path, `${path}/inbox?limit=10`]) {
      const response = await request(url);
      expect(response.status).toBe(200);
      const entries = response.body.inbox ?? response.body.entries;
      expect(entries).toContainEqual(expect.objectContaining({ id: 'desk-first', channel: 'desktop', ack: 'acked' }));
      expect(entries).toContainEqual(expect.objectContaining({ id: 'desk-second', ack: 'pending' }));
      const legacy = entries.find((entry: { text: string }) => entry.text === 'Legacy request');
      expect(legacy).toBeDefined();
      expect(legacy).not.toHaveProperty('ack');
      expect(legacy).not.toHaveProperty('id');
    }
    const posted = await request(`${path}/inbox`, 'New desktop request');
    expect(posted.status).toBe(201);
    const markdown = await readFile(inboxPath, 'utf8');
    expect(posted.body.id).toBe(/id:([^\]]+)\] New desktop request/.exec(markdown)?.[1]);
    expect(posted.body.id).toMatch(/^desk-/);
    const duplicate = await request(`${path}/inbox`, 'New desktop request');
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body).not.toHaveProperty('id');
    await writeFile(ledger, JSON.stringify({ entryId: 'desk-second', status: 'skipped', reason: 'No sender' }) + '\n');
    expect((await request(`${path}/inbox`)).body.entries).toContainEqual(expect.objectContaining({ id: 'desk-second', ack: 'skipped' }));
    expect(readInboxAckStates(runsDir).get('desk-second')).toEqual({ status: 'skipped', reason: 'No sender' });
    await writeFile(ledger, 'x'.repeat(256 * 1024) + '\n' + JSON.stringify({ entryId: 'tail', status: 'acked' }) + '\n');
    expect([...readInboxAckStates(runsDir)]).toEqual([['tail', { status: 'acked' }]]);
    await rm(ledger);
    expect(readInboxAckStates(runsDir).size).toBe(0);
  } finally { await rm(runsDir, { recursive: true, force: true }); }
});
