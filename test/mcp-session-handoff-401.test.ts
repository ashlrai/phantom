import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTE, parseFleetSessionHandoffArgs, readFleetSessionHandoff } from '../src/mcp/fleet-session-handoff.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const now = () => new Date('2026-11-15T00:00:00.000Z');
const row = (revision: number, extra: object = {}) => ({
  schema: 'session-handoff.v1', revision, at: '2026-11-14T12:00:00.000Z', signal: { kind: 'checkpoint' },
  job: 'job-1', attempt: 'att-1', repo: 'fake/repo', lane: 'lane-a', model: 'fake-model', minTier: 'mid',
  needs: ['git'], goal: 'Do the fake thing', plan: [{ action: `step ${revision}`, state: 'pending' }],
  filesTouched: ['src/a.ts'], decisions: ['d1'], evidence: ['e1'], nextAction: `next ${revision}`,
  contextDigest: 'opaque-context', repoState: { root: '/fake/host/root', head: 'a'.repeat(40), digest: 'b'.repeat(64), entireCheckpoint: null },
  ...extra,
});

let runs: string;
const emptyDir = () => mkdirSync(join(runs, 'handffs'), { recursive: true, mode: 0o700 });
function journal(job: string, text: string) {
  const dir = join(runs, 'handffs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${job}.jsonl`);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}
beforeEach(() => { runs = realpathSync(mkdtempSync(join(tmpdir(), 'session-handoff-401-'))); chmodSync(runs, 0o700); });
afterEach(() => rmSync(runs, { recursive: true, force: true }));

describe('fleet_session_handoff (401)', () => {
  it('returns the latest revision without root or contextDigest', () => {
    journal('job-1', [row(1), row(2)].map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = readFleetSessionHandoff({ job: 'job-1' }, { runsDir: runs, now }) as Record<string, any>;
    expect(out).toMatchObject({ v: 1, authority: 'none', status: 'ok', job: 'job-1', asOf: '2026-11-15T00:00:00.000Z', note: NOTE });
    expect(out.checkpoint.revision).toBe(2);
    expect(out.checkpoint.nextAction).toBe('next 2');
    expect(out.checkpoint.repoState).toEqual({ head: 'a'.repeat(40) });
    const text = JSON.stringify(out);
    expect(text).not.toContain('/fake/host/root');
    expect(text).not.toContain('opaque-context');
    expect(text).not.toContain('contextDigest');
  });

  it('reports none for a missing journal', () => {
    emptyDir();
    const out = readFleetSessionHandoff({ job: 'nope' }, { runsDir: runs, now });
    expect(out).toMatchObject({ status: 'none', job: 'nope' });
    expect(out).not.toHaveProperty('checkpoint');
  });

  it('reports unavailable without error text for a corrupt journal', () => {
    journal('job-1', 'not json at all\n');
    const out = readFleetSessionHandoff({ job: 'job-1' }, { runsDir: runs, now });
    expect(out).toMatchObject({ status: 'unavailable', reason: 'session-handoff-reader-failed' });
    expect(JSON.stringify(out)).not.toMatch(/Invalid handoff|Unreadable|Unexpected token|JSON/);
  });

  it('parser accepts exactly a safe job', () => {
    expect(parseFleetSessionHandoffArgs({ job: 'job-1' })).toEqual({ job: 'job-1' });
    for (const bad of [{}, { job: 'a', runs: '/x' }, { job: 'a/b' }, { job: '..' }, { job: '../x' }, { job: 7 }, { runs: '/x' }]) {
      expect(parseFleetSessionHandoffArgs(bad)).toBeNull();
    }
  });

  it('is listed by the fleet server and refuses bad args before reading', async () => {
    let reads = 0;
    emptyDir();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
      sessionHandoff: input => { reads++; return readFleetSessionHandoff(input, { runsDir: runs, now }); } });
    await server.connect(st);
    const client = new Client({ name: 'session-handoff-test', version: '1.0.0' });
    await client.connect(ct);
    try {
      const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_session_handoff');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      const ok = await client.callTool({ name: 'fleet_session_handoff', arguments: { job: 'missing' } });
      expect(JSON.parse((ok.content as Array<{ text: string }>)[0]!.text).status).toBe('none');
      expect(reads).toBe(1);
      const bad = await client.callTool({ name: 'fleet_session_handoff', arguments: { job: 'x', runs: '/etc' } }).catch(e => e);
      expect(reads).toBe(1);
      expect((bad as { isError?: boolean }).isError === true || bad instanceof Error).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
