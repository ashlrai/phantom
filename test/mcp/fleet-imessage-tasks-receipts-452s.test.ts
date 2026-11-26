/**
 * RQ-PHX-IMSGTASKMCP452S — fleet_imessage_tasks: read-only teammate task
 * ledger evidence through the isolated fleet MCP server, so a shell-free
 * coordination agent can distinguish an actual Dot/Instinct task
 * reservation, its transport receipt and any peer-reported result via the
 * same listTeammateTasks collector the CLI uses — never a second store.
 *
 * Hermetic: temp-dir runs roots, synthetic teammate-tasks.json ledgers,
 * in-memory MCP transports and injected readers; no daemon, transport,
 * Messages or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  DEFAULT_FLEET_IMESSAGE_TASKS, MAX_FLEET_IMESSAGE_TASKS, parseFleetImessageTasksArgs,
  readFleetImessageTasks, type FleetImessageTasksDeps,
} from '../../src/mcp/fleet-imessage-tasks.js';
import { listTeammateTasks, type TeammateTaskOptions } from '../../src/core/comms/imessage-teammate-tasks.js';

const connections: Client[] = [];
let root: string;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-imessage-tasks-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(
  readers: Partial<Pick<FleetReaders, 'imessageTasks'>> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'imessage-tasks-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

/** The real adapter through the real server, pointed at the temp runs dir. */
function realTasksReader(deps: FleetImessageTasksDeps = {}): FleetReaders['imessageTasks'] {
  return async input => readFleetImessageTasks(input, { runsDir: root, ...deps });
}

const COVERAGE = 'local-evidence-only-peer-reported-results-unverified';

function imessageDir(): string {
  const dir = join(root, 'imessage');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function ledgerPath(): string {
  return join(imessageDir(), 'teammate-tasks.json');
}
function writeLedger(text: string): string {
  const file = ledgerPath();
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

const token = (n: number) => n.toString(16).padStart(32, '0');
/** A schema-valid queued task; `extra` carries state/receipt/result overrides. */
function task(jobId: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    jobId, peer: 'dot', kind: 'research',
    scope: `FAKE_PRIVATE_SCOPE_${jobId}`, repo: 'ashlrai/phantom', prRefs: [],
    format: 'FAKE_PRIVATE_FORMAT', deadline: '2027-06-01T00:00:00.000Z',
    token: token(n), createdAt: 1763000000000 + n, state: 'queued',
    metrics: [], settled: false, ...extra,
  };
}
function ledger(tasks: object[]): string {
  return JSON.stringify({ v: 1, tasks, attempts: { dot: [], instinct: [] } });
}

/** relpath → kind+content hash over the whole runs root; proves read-only. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = path.slice(dir.length + 1);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) { out[`${rel}/`] = 'dir'; walk(path); }
      else out[rel] = `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

const MIXED_TASKS = [
  task('RQ-PHX-TQ-1', 1),
  task('RQ-PHX-TP-2', 2, {
    peer: 'instinct', state: 'pending', attemptedAt: 1763000001001,
    receipt: { rowid: 41, sent: true, delivered: false, error: 0 },
  }),
  task('RQ-PHX-TR-3', 3, {
    state: 'replied', attemptedAt: 1763000001002, settled: true,
    receipt: { rowid: 40, sent: true, delivered: true, error: 0 },
    result: { rowid: 55, status: 'DONE', summary: 'FAKE_PRIVATE_RESULT_SUMMARY', at: 1763000002003 },
  }),
  task('RQ-PHX-TE-4', 4, { state: 'expired', settled: true }),
];

describe('fleet_imessage_tasks over MCP', () => {
  it('is advertised read-only with jobId and bounded limit selectors', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_imessage_tasks');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$', description: 'Exact job id selector such as RQ-PHX-EXAMPLE-1; applied before limit truncation.' },
        peer: { type: 'string', enum: ['dot', 'instinct'], description: 'Exact peer selector; ANDed with the other selectors.' },
        state: { type: 'string', enum: ['queued', 'sending', 'pending', 'replied', 'expired', 'cancelled'], description: 'Exact local ledger-state selector; ANDed with the other selectors.' },
        kind: { type: 'string', enum: ['research', 'triage', 'report', 'rebase'], description: 'Exact work-kind selector; ANDed with the other selectors.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_IMESSAGE_TASKS, default: DEFAULT_FLEET_IMESSAGE_TASKS },
      },
      additionalProperties: false,
    });
  });

  it('dispatches the default and explicit selectors to the injected reader', async () => {
    const reader = vi.fn(async (input: unknown) => ({ input }));
    const client = await connect({ imessageTasks: reader });
    expect(parse(await client.callTool({ name: 'fleet_imessage_tasks' }))).toEqual({ input: { limit: 20 } });
    expect(parse(await client.callTool({ name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-EXAMPLE-1' } })))
      .toEqual({ input: { jobId: 'RQ-PHX-EXAMPLE-1', limit: 20 } });
    expect(parse(await client.callTool({ name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-EXAMPLE-1', limit: 7 } })))
      .toEqual({ input: { jobId: 'RQ-PHX-EXAMPLE-1', limit: 7 } });
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('reads a real synthetic ledger through the actual MCP call path with a strict projection', async () => {
    writeLedger(ledger(MIXED_TASKS));
    const seen: Array<TeammateTaskOptions | undefined> = [];
    const client = await connect({ imessageTasks: realTasksReader({
      listTasks: options => { seen.push(options); return listTeammateTasks(options); },
    }) });
    const result = await client.callTool({ name: 'fleet_imessage_tasks' });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual([{ runsDir: root }]);
    const serialized = JSON.stringify(result);
    for (const marker of ['FAKE_PRIVATE', token(1), token(2), token(3), token(4), '"token"', '"scope"', '"format"', '"summary"', '"metrics"', '"settled"', '"kind"', '"repo"', '"prRefs"']) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toContain(root);
    const out = parse(result);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'ok', ledgerState: 'present', coverage: COVERAGE,
      limit: 20, jobId: null, matched: null,
    });
    expect(typeof out.generatedAt).toBe('string');
    expect(out.tasks).toHaveLength(4);
    const ALLOWED_KEYS = [
      'jobId', 'peer', 'resource', 'state', 'claimKey', 'createdAt', 'attemptedAt',
      'deadline', 'transportReceipt', 'result', 'queueBinding', 'queueClaim',
    ];
    for (const row of out.tasks) {
      for (const key of Object.keys(row)) expect(ALLOWED_KEYS).toContain(key);
    }
    const [queued, pending, replied, expired] = out.tasks;
    expect(queued).toMatchObject({
      jobId: 'RQ-PHX-TQ-1', peer: 'dot', resource: 'imsg:dot',
      state: 'queued', claimKey: 'queue:imsg.dot.RQ-PHX-TQ-1',
      createdAt: 1763000000001, deadline: '2027-06-01T00:00:00.000Z',
      transportReceipt: null, result: null,
    });
    expect(queued).not.toHaveProperty('attemptedAt');
    expect(pending).toHaveProperty('attemptedAt', 1763000001001);
    expect(replied).toHaveProperty('attemptedAt', 1763000001002);
    expect(expired).not.toHaveProperty('attemptedAt');
    expect(pending).toMatchObject({
      jobId: 'RQ-PHX-TP-2', peer: 'instinct', resource: 'imsg:instinct', state: 'pending',
      attemptedAt: 1763000001001,
      transportReceipt: { rowid: 41, sent: true, delivered: false, error: 0 },
      result: null,
    });
    expect(replied).toMatchObject({
      jobId: 'RQ-PHX-TR-3', state: 'replied',
      transportReceipt: { rowid: 40, sent: true, delivered: true, error: 0 },
      result: { rowid: 55, status: 'DONE', at: 1763000002003, evidence: 'peer-reported' },
    });
    expect(expired).toMatchObject({ jobId: 'RQ-PHX-TE-4', state: 'expired', transportReceipt: null, result: null });
  });

  it('filters by exact jobId before truncation and reports an explicit no-match', async () => {
    const bulk = Array.from({ length: 25 }, (_, i) =>
      task(`RQ-PHX-BULK-${String(i).padStart(3, '0')}`, 100 + i));
    writeLedger(ledger(bulk));
    const client = await connect({ imessageTasks: realTasksReader() });
    // The oldest row survives an exact selector even though limit would cut it unfiltered.
    const selected = parse(await client.callTool({
      name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-BULK-000', limit: 5 },
    }));
    expect(selected).toMatchObject({ jobId: 'RQ-PHX-BULK-000', matched: true, sourceState: 'ok', ledgerState: 'present' });
    expect(selected.tasks.map((row: { jobId: string }) => row.jobId)).toEqual(['RQ-PHX-BULK-000']);
    // Unfiltered reads keep the newest `limit` rows in collector order.
    const page = parse(await client.callTool({ name: 'fleet_imessage_tasks', arguments: { limit: 5 } }));
    expect(page.tasks.map((row: { jobId: string }) => row.jobId))
      .toEqual(['RQ-PHX-BULK-020', 'RQ-PHX-BULK-021', 'RQ-PHX-BULK-022', 'RQ-PHX-BULK-023', 'RQ-PHX-BULK-024']);
    // An unknown selector is an explicit no-match, never another task.
    const miss = parse(await client.callTool({
      name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-BULK-999' },
    }));
    expect(miss).toMatchObject({ jobId: 'RQ-PHX-BULK-999', matched: false, sourceState: 'ok', tasks: [] });
  });

  it('distinguishes a missing ledger from a healthy empty assignment', async () => {
    const client = await connect({ imessageTasks: realTasksReader() });
    const out = parse(await client.callTool({ name: 'fleet_imessage_tasks' }));
    expect(out).toMatchObject({ sourceState: 'ok', ledgerState: 'missing', matched: null, tasks: [] });
    const selected = parse(await client.callTool({
      name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-TQ-1' },
    }));
    expect(selected).toMatchObject({ sourceState: 'ok', ledgerState: 'missing', matched: false, tasks: [] });
  });

  it('reports a corrupt ledger as fixed unavailable evidence, never an empty page', async () => {
    writeLedger('this is not json');
    const client = await connect({ imessageTasks: realTasksReader() });
    const result = await client.callTool({ name: 'fleet_imessage_tasks' });
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('this is not json');
    expect(serialized).not.toContain('Teammate task state');
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'unavailable', ledgerState: 'present', matched: null, tasks: null,
    });
  });

  it('reports a throwing collector as fixed unavailable evidence without raw exception text', async () => {
    writeLedger(ledger(MIXED_TASKS));
    const client = await connect({ imessageTasks: realTasksReader({
      listTasks: () => { throw new Error('private-collector-detail'); },
    }) });
    const result = await client.callTool({ name: 'fleet_imessage_tasks' });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
    expect(parse(result)).toMatchObject({ sourceState: 'unavailable', tasks: null });
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect({ imessageTasks: async () => { throw new Error('private-source-value'); } });
    const result = await client.callTool({ name: 'fleet_imessage_tasks' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it.each([
    { jobId: 5 }, { jobId: null }, { jobId: '' }, { jobId: 'bad job!' }, { jobId: 'x'.repeat(81) },
    { jobId: 'ghp_' + 'A1b2C3d4'.repeat(5) }, { job: 'RQ-PHX-1' }, { job_id: 'RQ-PHX-1' }, { id: 'RQ-PHX-1' },
    { jobIds: ['RQ-PHX-1'] },
    { limit: 0 }, { limit: 101 }, { limit: -1 }, { limit: 1.5 }, { limit: '5' }, { limit: null }, { limit: true },
    { dir: '/tmp/fake' }, { root: '/tmp' }, { cwd: '/tmp' }, { path: '/tmp' }, { runsDir: '/tmp' },
    { config: {} }, { send: true }, { poll: true }, { apply: true }, { enqueue: true }, { claim: true },
    { jobId: 'RQ-PHX-1', x: 1 }, { limit: 5, dir: '/tmp' },
  ])('rejects arguments before any collector read: %j', async (args) => {
    const listTasks = vi.fn(() => ({ schema: 'x', state: 'healthy', tasks: [] }));
    const client = await connect({ imessageTasks: async input => readFleetImessageTasks(input, { runsDir: root, listTasks }) });
    await expect(client.callTool({ name: 'fleet_imessage_tasks', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('leaves the runs tree untouched (read-only)', async () => {
    writeLedger(ledger(MIXED_TASKS));
    const before = snapshotTree(root);
    const client = await connect({ imessageTasks: realTasksReader() });
    expect(parse(await client.callTool({ name: 'fleet_imessage_tasks' })).tasks).toHaveLength(4);
    expect(parse(await client.callTool({
      name: 'fleet_imessage_tasks', arguments: { jobId: 'RQ-PHX-TR-3' },
    })).tasks).toHaveLength(1);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('parseFleetImessageTasksArgs applies defaults and enforces bounds', () => {
    expect(parseFleetImessageTasksArgs({})).toEqual({ limit: 20 });
    expect(parseFleetImessageTasksArgs({ jobId: 'RQ-PHX-1' })).toEqual({ jobId: 'RQ-PHX-1', limit: 20 });
    expect(parseFleetImessageTasksArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseFleetImessageTasksArgs({ limit: 100 })).toEqual({ limit: 100 });
    for (const args of [
      { jobId: 5 }, { jobId: null }, { jobId: 'has space' }, { jobId: 'x'.repeat(81) },
      { job: 'RQ-1' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { limit: null },
      { jobId: 'RQ-1', x: 1 }, { dir: '/tmp' }, { send: true }, { runsDir: '/tmp' },
    ]) expect(parseFleetImessageTasksArgs(args)).toBeNull();
  });
});

