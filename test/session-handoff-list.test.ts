import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listSessionHandoffs } from '../src/core/agents/session-handoff.js';
import { cmdSessionHandoff } from '../src/cli/session-handoff.js';
import { NOTE, parseFleetSessionHandoffsArgs, readFleetSessionHandoffs } from '../src/mcp/fleet-session-handoffs.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const now = () => new Date('2026-11-20T00:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function tmpdir_(): string {
  // Canonical base, matching the realpathSync(mkdtempSync(...)) convention in
  // the other handoff suites: listSessionHandoffs resolves runs before reading.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-handoff-list-')));
  dirs.push(dir);
  return dir;
}

function runsDir(parent: string): string {
  const runs = join(parent, 'runs');
  mkdirSync(runs, { mode: 0o700 });
  return runs;
}

function journalRecord(job: string, extra: Record<string, unknown> = {}) {
  return {
    schema: 'session-handoff.v1', revision: 1, at: '2026-11-20T10:00:00.000Z',
    signal: { kind: 'checkpoint' },
    job, attempt: 'att-1', repo: 'test/fixture', lane: 'codex-personal', model: 'model-a',
    minTier: 'work', needs: ['typescript'], goal: 'Do the fake thing',
    plan: [{ action: 'step 1', state: 'pending' }], filesTouched: ['result'],
    decisions: ['keep it'], evidence: ['e1'], nextAction: 'do step 1', contextDigest: 'ctx',
    repoState: { root: '/fake/host/root', head: 'a'.repeat(40), digest: 'b'.repeat(64), entireCheckpoint: null },
    ...extra,
  };
}

function writeJournal(runs: string, job: string, records: object[]) {
  const dir = join(runs, 'handoffs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${job}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
}

it('lists open and completed journals newest-first without packet payload', () => {
  const runs = runsDir(tmpdir_());
  writeJournal(runs, 'alpha', [journalRecord('alpha')]);
  writeJournal(runs, 'beta', [
    journalRecord('beta', { revision: 1, signal: { kind: 'checkpoint' } }),
    journalRecord('beta', { revision: 2, at: '2026-11-20T11:00:00.000Z', signal: { kind: 'completed' },
      plan: [{ action: 'step 1', state: 'done' }] }),
  ]);
  const result = listSessionHandoffs(runs);
  expect(result).toMatchObject({ schema: 'session-handoff.list.v1', status: 'ok', unreadable: [], truncated: false });
  expect(result.handoffs).toHaveLength(2);
  const [first, second] = result.handoffs!;
  expect(first).toMatchObject({ job: 'beta', attempt: 'att-1', revision: 2, state: 'completed',
    lane: 'codex-personal', model: 'model-a', minTier: 'work', repo: 'test/fixture',
    signal: { kind: 'completed' }, needs: ['typescript'], head: 'a'.repeat(40) });
  expect(second).toMatchObject({ job: 'alpha', revision: 1, state: 'open', signal: { kind: 'checkpoint' } });
  for (const entry of result.handoffs!) {
    for (const dropped of ['goal', 'plan', 'filesTouched', 'decisions', 'evidence', 'nextAction', 'contextDigest', 'repoState', 'schema']) {
      expect(entry).not.toHaveProperty(dropped);
    }
  }
});

it('reports missing for absent runs and handoffs directories', () => {
  const parent = tmpdir_();
  expect(listSessionHandoffs(join(parent, 'never-written'))).toEqual({
    schema: 'session-handoff.list.v1', status: 'missing', handoffs: [], unreadable: [], truncated: false });
  const runs = runsDir(parent);
  expect(listSessionHandoffs(runs)).toEqual({
    schema: 'session-handoff.list.v1', status: 'missing', handoffs: [], unreadable: [], truncated: false });
});

it('isolates a corrupt journal in unreadable while listing the rest', () => {
  const runs = runsDir(tmpdir_());
  writeJournal(runs, 'good', [journalRecord('good')]);
  const dir = join(runs, 'handoffs');
  writeFileSync(join(dir, 'bad.jsonl'), 'not json at all\n', { mode: 0o600 });
  writeFileSync(join(dir, 'torn.jsonl'), JSON.stringify(journalRecord('torn')) , { mode: 0o600 }); // no trailing newline
  const result = listSessionHandoffs(runs);
  expect(result.status).toBe('ok');
  expect(result.unreadable).toEqual(['bad', 'torn']);
  expect(result.handoffs!.map(entry => entry.job)).toEqual(['good']);
});

it('ignores non-journal names but reports an unreadable *.jsonl directory', () => {
  const runs = runsDir(tmpdir_());
  const dir = join(runs, 'handoffs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['job.lock', 'job.jsonl.tmp', 'bad name.jsonl', 'also-bad!.jsonl', 'plain.txt']) {
    writeFileSync(join(dir, name), 'x', { mode: 0o600 });
  }
  mkdirSync(join(dir, 'dir.jsonl'));
  const result = listSessionHandoffs(runs);
  expect(result.status).toBe('ok');
  expect(result.handoffs).toEqual([]);
  expect(result.unreadable).toEqual(['dir']);
});

it('bounds the scan to the newest 256 journals and flags truncation', () => {
  const runs = runsDir(tmpdir_());
  for (let i = 0; i < 257; i++) writeJournal(runs, `job-${String(i).padStart(3, '0')}`, [journalRecord(`job-${String(i).padStart(3, '0')}`)]);
  const result = listSessionHandoffs(runs);
  expect(result.status).toBe('ok');
  expect(result.truncated).toBe(true);
  expect(result.handoffs).toHaveLength(256);
  expect(result.unreadable).toEqual([]);
});

it('reports unavailable with null lists when the store cannot be read', () => {
  const runs = runsDir(tmpdir_());
  writeJournal(runs, 'job', [journalRecord('job')]);
  chmodSync(runs, 0);
  try {
    const result = listSessionHandoffs(runs);
    expect(result).toEqual({ schema: 'session-handoff.list.v1', status: 'unavailable',
      handoffs: null, unreadable: null, truncated: false });
  } finally { chmodSync(runs, 0o700); }
});

it('serves the list verb through the checkpoint handoff CLI', async () => {
  const runs = runsDir(tmpdir_());
  writeJournal(runs, 'job', [journalRecord('job')]);
  const printed: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation(line => { printed.push(String(line)); });
  expect(await cmdSessionHandoff(['list', runs, '--json'])).toBe(0);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.parse(printed[0]!)).toMatchObject({ status: 'ok', schema: 'session-handoff.list.v1' });
  expect(await cmdSessionHandoff(['list'])).toBe(2);
  expect(await cmdSessionHandoff(['list', runs, 'extra'])).toBe(2);
});

describe('fleet_session_handoffs MCP tool', () => {
  it('parses exactly zero arguments', () => {
    expect(parseFleetSessionHandoffsArgs({})).toEqual({});
    for (const bad of [{ job: 'a' }, { runs: '/x' }, { limit: 1 }]) {
      expect(parseFleetSessionHandoffsArgs(bad)).toBeNull();
    }
  });

  it('passes the core index through sanitized and reports reader failure', () => {
    const handoffs = [{ job: 'job', attempt: 'att', revision: 1, at: '2026-11-20T10:00:00.000Z',
      lane: 'l', model: 'm', minTier: 'work', repo: 'a/b', signal: { kind: 'checkpoint' },
      needs: [], state: 'open', head: 'a'.repeat(40) }];
    const ok = readFleetSessionHandoffs({}, { list: () => ({ schema: 'session-handoff.list.v1', status: 'ok',
      handoffs: handoffs as never, unreadable: [], truncated: false }), now }) as Record<string, any>;
    expect(ok).toMatchObject({ v: 1, authority: 'none', status: 'ok', asOf: '2026-11-20T00:00:00.000Z', note: NOTE,
      truncated: false });
    expect(ok.handoffs).toEqual(handoffs);
    const failed = readFleetSessionHandoffs({}, { list: () => { throw new Error('boom'); }, now }) as Record<string, any>;
    expect(failed).toMatchObject({ status: 'unavailable', reason: 'session-handoff-list-reader-failed',
      handoffs: null, unreadable: null });
    expect(JSON.stringify(failed)).not.toContain('boom');
  });

  it('reads a real journal store without packet payload fields', () => {
    const runs = runsDir(tmpdir_());
    writeJournal(runs, 'job', [journalRecord('job')]);
    const out = readFleetSessionHandoffs({}, { runsDir: runs, now }) as Record<string, any>;
    expect(out.status).toBe('ok');
    expect(out.handoffs).toHaveLength(1);
    expect(out.handoffs[0]).toMatchObject({ job: 'job', state: 'open', head: 'a'.repeat(40) });
    for (const dropped of ['goal', 'plan', 'filesTouched', 'decisions', 'evidence', 'nextAction', 'contextDigest', 'repoState', 'schema']) {
      expect(out.handoffs[0]).not.toHaveProperty(dropped);
    }
    const text = JSON.stringify(out);
    for (const dropped of ['contextDigest', '/fake/host/root', 'nextAction']) expect(text).not.toContain(dropped);
  });

  it('is listed by the fleet server and refuses arguments before reading', async () => {
    const runs = runsDir(tmpdir_());
    writeJournal(runs, 'job', [journalRecord('job')]);
    let reads = 0;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
      sessionHandoffs: () => { reads++; return readFleetSessionHandoffs({}, { runsDir: runs, now }); } });
    await server.connect(st);
    const client = new Client({ name: 'session-handoffs-test', version: '1.0.0' });
    await client.connect(ct);
    try {
      const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_session_handoffs');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      const ok = await client.callTool({ name: 'fleet_session_handoffs', arguments: {} });
      expect(JSON.parse((ok.content as Array<{ text: string }>)[0]!.text).status).toBe('ok');
      expect(reads).toBe(1);
      const bad = await client.callTool({ name: 'fleet_session_handoffs', arguments: { job: 'x' } }).catch(e => e);
      expect(reads).toBe(1);
      expect((bad as { isError?: boolean }).isError === true || bad instanceof Error).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('is documented in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_session_handoffs` \|/m);
  });
});
