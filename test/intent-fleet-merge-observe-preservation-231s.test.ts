import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { IntentItem, IntentLedger } from '../src/core/intent/schema.js';

const TOKEN = 'fleet-test-token';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const AT = '2026-10-01T00:00:00.000Z';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'intent-observe-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function item(id: string, rq: string, status: IntentItem['status'], extra: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Fake directive ${rq}`, source: 'test', owner: 'tester', rq: [rq], prs: [], status, evidence: [],
    provenance: [{ source: 'fake-source', date: null, verbatim: true, partial: true }], partial: true, closureProposal: null,
    lastTouchedAt: AT, staleAfterMs: 86_400_000, createdAt: AT, updatedAt: AT, ...extra,
  };
}
const ledgerPath = () => join(dir, 'intent', 'ledger.json');
async function seed(items: IntentItem[]): Promise<void> {
  await mkdir(join(dir, 'intent'), { recursive: true });
  const ledger: IntentLedger = { schema: 'ashlr.intent-ledger/v1', items };
  await writeFile(ledgerPath(), `${JSON.stringify(ledger)}\n`);
}
const load = async () => (JSON.parse(await readFile(ledgerPath(), 'utf8')) as IntentLedger).items;

async function snapshot(rows: unknown[]): Promise<{ status: number; wire: Record<string, any> | null }> {
  const deps: FleetRunsApiDeps = {
    now: () => NOW, runsDir: dir,
    readRunsDir: async () => ({ lastTick: null, paused: false, memFreePct: 1, diskFreeGb: 1, switches: [], claudeLane: null, lanes: [], publishesLastHour: [], events: [], drop: null }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: 0 }),
    readInbox: async () => [], readOutbox: async () => [], appendInbox: async () => ({ ok: true }),
    readHostLoad: () => null,
    codexPersonal: async () => ({ usedPct: 1, resetsAt: null, asOf: null }),
    mergedLastHour: async () => ({ count: rows.length, items: rows }),
  };
  const api = createFleetRunsApi(deps);
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = PATH; req.method = 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0; let wire: Record<string, any> | null = null;
  const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } } } as unknown as ServerResponse;
  await api({ cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { status, wire };
}
const pull = { repo: 'fake-org/fake-repo', number: 7, title: 'RQ-FAKE-ONE work' };

describe('fleet snapshot merge observation', () => {
  it('advances only the matching open directive and preserves others', async () => {
    await seed([
      item('a', 'RQ-FAKE-ONE', 'queued'), item('b', 'RQ-FAKE-TWO', 'queued'),
      item('c', 'RQ-FAKE-ONE', 'shipped'), item('d', 'RQ-FAKE-ONE', 'verified'), item('e', 'RQ-FAKE-ONE', 'closed'),
    ]);
    const { status, wire } = await snapshot([pull]);
    expect(status).toBe(200);
    expect(wire!.sources.merges).toBe('healthy');
    const items = await load();
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by['a']!.status).toBe('merged');
    expect(by['a']!.prs).toEqual([{ repo: 'fake-org/fake-repo', number: 7, state: 'merged' }]);
    expect(by['a']!.evidence).toEqual([{ at: new Date(NOW).toISOString(), kind: 'pr', ref: 'fake-org/fake-repo#7' }]);
    expect(by['a']!.provenance[0]!.partial).toBe(true);
    expect(by['a']!.partial).toBe(true);
    expect(by['b']).toEqual(item('b', 'RQ-FAKE-TWO', 'queued'));
    expect(['c', 'd', 'e'].map((id) => by[id]!.status)).toEqual(['shipped', 'verified', 'closed']);
  });

  it('is byte-stable across repeated identical snapshots', async () => {
    await seed([item('a', 'RQ-FAKE-ONE', 'queued')]);
    await snapshot([pull]);
    const first = await readFile(ledgerPath(), 'utf8');
    const mtime = (await stat(ledgerPath())).mtimeMs;
    await snapshot([pull, pull]);
    expect(await readFile(ledgerPath(), 'utf8')).toBe(first);
    expect((await stat(ledgerPath())).mtimeMs).toBe(mtime);
    expect((await load())[0]!.evidence).toHaveLength(1);
  });

  it('ignores malformed and unknown rows and keeps the snapshot healthy', async () => {
    await seed([item('a', 'RQ-FAKE-ONE', 'queued')]);
    const before = await readFile(ledgerPath(), 'utf8');
    const { status, wire } = await snapshot([
      { repo: 'not a repo', number: 1, title: 'RQ-FAKE-ONE' }, { repo: 'fake-org/fake-repo', number: -3, title: 'RQ-FAKE-ONE' },
      { repo: 'fake-org/fake-repo', number: 9, title: 'RQ-UNKNOWN-NINE' },
    ]);
    expect(status).toBe(200);
    expect(wire!.sources.merges).toBe('healthy');
    expect(await readFile(ledgerPath(), 'utf8')).toBe(before);
  });

  it('never creates a ledger for unrelated observations', async () => {
    const { status } = await snapshot([pull]);
    expect(status).toBe(200);
    await expect(stat(join(dir, 'intent'))).rejects.toThrow();
  });

  it('leaves a corrupt ledger untouched while the snapshot succeeds', async () => {
    await mkdir(join(dir, 'intent'), { recursive: true });
    await writeFile(ledgerPath(), '{not json');
    const { status, wire } = await snapshot([pull]);
    expect(status).toBe(200);
    expect(wire!.mergesLastHour.count).toBe(1);
    expect(await readFile(ledgerPath(), 'utf8')).toBe('{not json');
  });
});
