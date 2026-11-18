// Damaged retained recheck-history rows through the real MCP route
// (RQ-PHX-HISTORYDAMAGEDROWMCP340S): a parseable row missing or mistyping
// required nested evidence must be skipped, never admitted as valid runtime
// or claim evidence, and must not cost the intact rows around it.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { recheckLogPath, RECHECK_RECORD_SCHEMA } from '../src/core/fleet/recheck-record.js';

const clients: Client[] = [];
const roots: string[] = [];
const savedAshlrHome = process.env.ASHLR_HOME;

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  if (savedAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = savedAshlrHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phantom-recheck-damaged-'));
  roots.push(root);
  return root;
}

const AS_OF = '2026-11-14T04:00:00.000Z';

/** A complete current-format row: every required nested field present. */
function validRow(asOf: string, overall = 'VERIFIED'): Record<string, unknown> {
  return {
    schema: RECHECK_RECORD_SCHEMA,
    asOf,
    overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '0.0.0-fake', asOf },
      claims: { state: 'VERIFIED', active: 2, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: {
        state: 'VERIFIED', id: 'fake-task', owner: 'fake-owner',
        claimReceipt: 'bus-claim:fake:0:1', asOf,
        lastVerified: { id: 'fake-done', owner: 'fake-owner', asOf },
      },
      missing: { overall: [], runtime: [], claims: [], bridge: [], task: [] },
    },
  };
}

/** A documented older row: no retained reasons and no lastVerified evidence;
 * the reader normalizes both to null rather than rejecting the row. */
function legacyRow(asOf: string): Record<string, unknown> {
  const row = validRow(asOf, 'BLOCKED') as { sections: Record<string, unknown> };
  delete row.sections['missing'];
  const task = row.sections['task'] as Record<string, unknown>;
  delete task['lastVerified'];
  return row;
}

/** Clone a valid row and delete one required nested field. */
function without(row: Record<string, unknown>, section: string, field: string): Record<string, unknown> {
  const clone = structuredClone(row) as { sections: Record<string, Record<string, unknown>> };
  delete clone.sections[section]![field];
  return clone;
}

function writeLog(home: string, lines: string[]): string {
  mkdirSync(join(home, 'fleet'), { recursive: true });
  const file = recheckLogPath(home);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return readFileSync(file, 'utf8');
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // No recheckHistory reader is injected: the server's default is the real
  // readFleetRecheckHistoryTool against ASHLR_HOME.
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
  const client = new Client({ name: 'fleet-recheck-damaged-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const parsed = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

async function history(client: Client, last?: number): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'fleet_recheck_history',
    arguments: last === undefined ? {} : { last },
  });
  expect(result.isError).toBeUndefined();
  return parsed(result);
}

describe('fleet_recheck_history with damaged retained rows', () => {
  it('skips truncated and structurally incomplete rows, keeps valid rows newest-first', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    const oldest = legacyRow('2026-11-13T10:00:00.000Z');
    const newest = validRow(AS_OF, 'BLOCKED');
    const damaged: unknown[] = [
      without(validRow('2026-11-14T03:30:00.000Z'), 'runtime', 'host'),
      without(validRow('2026-11-14T03:20:00.000Z'), 'claims', 'active'),
      without(validRow('2026-11-14T03:10:00.000Z'), 'task', 'claimReceipt'),
      without(validRow('2026-11-14T03:00:00.000Z'), 'bridge', 'missingBridge'),
      without(validRow('2026-11-14T02:50:00.000Z'), 'runtime', 'asOf'),
    ];
    // Wrong-typed nested evidence is just as malformed as missing evidence.
    const mistyped = structuredClone(validRow('2026-11-14T02:40:00.000Z')) as {
      sections: { claims: { active: unknown }; task: { id: unknown }; bridge: { missingBridge: unknown } }
    };
    mistyped.sections.claims.active = 'two';
    mistyped.sections.task.id = 42;
    mistyped.sections.bridge.missingBridge = { channel: 'slack' };
    damaged.push(mistyped);
    const badLastVerified = structuredClone(validRow('2026-11-14T02:30:00.000Z')) as {
      sections: { task: { lastVerified: unknown } }
    };
    badLastVerified.sections.task.lastVerified = { id: 'fake-done' };
    damaged.push(badLastVerified);

    // Oldest → newest: legacy valid, damaged rows, truncated JSON, newest valid.
    const lines = [
      JSON.stringify(oldest),
      ...damaged.map(row => JSON.stringify(row)),
      '{"schema":"fleet.recheck-record.v1","asOf":"2026-11-14T02',
      JSON.stringify(newest),
    ];
    const before = writeLog(home, lines);
    const body = await history(await connect(), 50);

    expect(body['missing']).toBe(false);
    expect(body['outcome']).toBe('ok');
    expect(body['skipped']).toBe(damaged.length + 1); // damaged rows + truncated line
    const rows = body['rows'] as Array<Record<string, unknown>>;
    expect(rows.map(r => r['asOf'])).toEqual([AS_OF, '2026-11-13T10:00:00.000Z']);
    // The current row keeps its lastVerified evidence; the legacy row is
    // normalized, not rejected.
    const current = rows[0]!['sections'] as { task: { lastVerified: { id: string } | null }; missing: unknown };
    expect(current.task.lastVerified?.id).toBe('fake-done');
    const legacy = rows[1]!['sections'] as { task: { lastVerified: unknown }; missing: unknown };
    expect(legacy.task.lastVerified).toBeNull();
    expect(legacy.missing).toBeNull();
    // Read-only: the log bytes and the directory are untouched.
    expect(readFileSync(recheckLogPath(home), 'utf8')).toBe(before);
    expect([readdirSync(home), readdirSync(join(home, 'fleet'))]).toEqual([['fleet'], ['recheck-log.jsonl']]);
  });

  it('a small last limit returns valid rows, never malformed ones', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    writeLog(home, [
      JSON.stringify(validRow('2026-11-14T01:00:00.000Z')),
      JSON.stringify(without(validRow('2026-11-14T02:00:00.000Z'), 'runtime', 'host')),
      JSON.stringify(validRow('2026-11-14T03:00:00.000Z')),
    ]);
    const body = await history(await connect(), 1);
    expect(body['skipped']).toBe(1);
    const rows = body['rows'] as Array<{ asOf: string }>;
    expect(rows.map(r => r.asOf)).toEqual(['2026-11-14T03:00:00.000Z']);
  });

  it('recovers intact rows after the damaged lines are repaired, same process', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    const client = await connect();
    writeLog(home, [
      JSON.stringify(validRow('2026-11-14T01:00:00.000Z')),
      'not json at all',
      JSON.stringify(without(validRow('2026-11-14T02:00:00.000Z'), 'claims', 'asOf')),
    ]);
    const damaged = await history(client, 5);
    expect(damaged['skipped']).toBe(2);
    expect((damaged['rows'] as unknown[]).length).toBe(1);

    // Repair: only valid rows remain; the next read needs no restart.
    writeLog(home, [
      JSON.stringify(validRow('2026-11-14T01:00:00.000Z')),
      JSON.stringify(validRow('2026-11-14T02:00:00.000Z', 'BLOCKED')),
    ]);
    const healed = await history(client, 5);
    expect(healed).toMatchObject({ skipped: 0, missing: false, outcome: 'ok' });
    expect((healed['rows'] as Array<{ asOf: string }>).map(r => r.asOf))
      .toEqual(['2026-11-14T02:00:00.000Z', '2026-11-14T01:00:00.000Z']);
  });
});
