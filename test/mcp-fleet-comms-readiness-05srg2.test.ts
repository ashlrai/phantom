import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetCommsReadiness } from '../src/core/mcp/fleet-comms-readiness.js';
import type { EmailDiagnosis } from '../src/core/comms/email-diagnosis.js';

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'comms-mcp-')); roots.push(dir); return dir; };
const email = (): EmailDiagnosis => ({
  config: 'ok', polling: 'enabled', sendReplies: 'disabled', outbox: 'ok', replies: 'draft-only',
  counts: { queued: 2, drafted: 1, sent: 0, stuck: 0 },
  coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery', checks: [],
});

it('exposes the shared local report through actual MCP registration', async () => {
  const runsDir = root();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'comms-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}),
    commsReadiness: () => readFleetCommsReadiness({ runsDir, diagnoseEmail: async dir => {
      expect(dir).toBe(runsDir);
      return email();
    }, checkIMessage: () => { throw new Error('fake private exception'); } }),
  }).connect(st);
  await client.connect(ct);
  expect((await client.listTools()).tools.find(tool => tool.name === 'fleet_comms_readiness')?.inputSchema)
    .toMatchObject({ properties: {}, additionalProperties: false });
  const result = await client.callTool({ name: 'fleet_comms_readiness', arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const report = JSON.parse(text);
  expect(report.schema).toBe('fleet.comms-cutover-readiness.v1');
  expect(report.coverage).toBe('local-evidence-only-not-delivery-proof');
  expect(report.capabilities.emailPolling.state).toBe('ready');
  expect(report.capabilities.emailOutbox).toMatchObject({ state: 'ready', reason: 'email-outbox-readable-draft-only', counts: email().counts });
  expect(report.overall.blockers).not.toContain('emailOutbox');
  expect(report.capabilities.ownerImessageIntake).toMatchObject({ state: 'unverified', reason: 'imessage-reader-unavailable' });
  expect(report.capabilities.gmailInboxTriage.state).toBe('unverified');
  expect(report.capabilities.linkedin.state).toBe('unverified');
  expect(report.overall).toMatchObject({ state: 'incomplete', commsbotRetirement: 'not-evidenced' });
  expect(text).not.toContain(runsDir);
  expect(text).not.toContain('fake private exception');
  await expect(client.callTool({ name: 'fleet_comms_readiness', arguments: { path: runsDir } })).rejects.toThrow();
});

it('fails closed on reader failures and does not return raw exceptions', async () => {
  const runsDir = root();
  const result = await readFleetCommsReadiness({ runsDir,
    diagnoseEmail: async () => { throw new Error('fake private exception'); },
    checkIMessage: () => { throw new Error('fake private exception'); },
  });
  expect(result.capabilities.emailPolling).toMatchObject({ state: 'unverified', reason: 'email-reader-unavailable' });
  expect(result.capabilities.emailOutbox.state).toBe('unverified');
  expect(result.capabilities.ownerImessageDelivery.state).toBe('unverified');
  expect(result.overall.state).toBe('incomplete');
  expect(JSON.stringify(result)).not.toContain('fake private exception');
});
