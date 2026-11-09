import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';

const home = process.env.HOME;
const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'batch-preservation-'));
  roots.push(root);
  process.env.HOME = root;
  const runs = join(root, '.ashlr-runs');
  const outbox = join(runs, 'outbox');
  mkdirSync(outbox, { recursive: true });
  mkdirSync(join(runs, 'queue'));
  writeFileSync(join(runs, EMAIL_DROP_CONFIG_FILE), JSON.stringify({ v: 1, inboxDir: join(runs, 'inbox'), outboxDir: outbox, from: ['owner@example.test'] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer();
  const client = new Client({ name: 'preservation', version: '1' });
  clients.push(client);
  await server.connect(b);
  await client.connect(a);
  return { client, outbox };
}
const report = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

describe('batch preservation through default fleet dispatch', () => {
  it('observes terminal and queued artifacts in order, then reports a missing source', async () => {
    const { client, outbox } = await setup();
    mkdirSync(join(outbox, 'drafted'));
    writeFileSync(join(outbox, 'drafted', 'a.reply.eml'), 'To: owner@example.test\r\nSubject: Test\r\n\r\nTest\r\n');
    writeFileSync(join(outbox, 'b.reply.eml'), 'To: owner@example.test\r\nSubject: Test\r\n\r\nTest\r\n');
    const args = { names: ['a.reply.eml', 'b.reply.eml'], timeoutMs: 100, pollMs: 100 };
    const result = report(await client.callTool({ name: 'fleet_email_outbox_batch_await', arguments: args }));
    expect(result).toMatchObject({ authority: 'none', sourceState: 'ok', timedOut: true, rows: [{ name: 'a.reply.eml', state: 'drafted' }, { name: 'b.reply.eml', state: 'queued' }] });
    rmSync(outbox, { recursive: true });
    expect(report(await client.callTool({ name: 'fleet_email_outbox_batch_await', arguments: args }))).toMatchObject({ sourceState: 'missing-outbox', sourceFailure: true, rows: null });
  });

  it('cancels an actual dispatched wait', async () => {
    const { client, outbox } = await setup();
    writeFileSync(join(outbox, 'a.reply.eml'), 'To: owner@example.test\r\nSubject: Test\r\n\r\nTest\r\n');
    const controller = new AbortController();
    const pending = client.callTool({ name: 'fleet_email_outbox_batch_await', arguments: { names: ['a.reply.eml'], timeoutMs: 5000, pollMs: 100 } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow();
  });
});
