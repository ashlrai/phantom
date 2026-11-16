import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_PATH, handleObserveApi, isObservePath } from '../src/core/verse/observe-api.js';
import { INTENT_LEDGER_SCHEMA, type IntentItem } from '../src/core/intent/schema.js';

const NOW = new Date().toISOString();
const OLD = '2020-01-01T00:00:00.000Z';

function item(id: string, over: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Fake directive ${id}`, source: 'fake-source', owner: 'fake-owner', rq: [], prs: [],
    status: 'queued', evidence: [], provenance: [{ source: 'fake-note', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: NOW, staleAfterMs: 86_400_000,
    createdAt: NOW, updatedAt: NOW, ...over,
  };
}

interface Reply { status: number; body: any }

async function call(method: string, path: string): Promise<Reply & { handled: boolean }> {
  const reply: Reply = { status: 0, body: null };
  const res = {
    writeHead(status: number) { reply.status = status; },
    end(payload?: string) { reply.body = payload ? JSON.parse(payload) : null; },
    setHeader() {},
  } as unknown as ServerResponse;
  const handled = await handleObserveApi({ url: path, method } as IncomingMessage, res, path, method);
  return { ...reply, handled };
}

describe('GET /api/verse/intent', () => {
  let dir: string;
  let prior: string | undefined;
  const ledgerDir = () => join(dir, 'intent');
  const ledgerFile = () => join(ledgerDir(), 'ledger.json');

  beforeEach(() => {
    prior = process.env['ASHLR_RUNS_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'intent-api-09spg1-'));
    process.env['ASHLR_RUNS_DIR'] = dir;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = prior;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is classified as an observe path', () => {
    expect(isObservePath(INTENT_PATH)).toBe(true);
    expect(isObservePath('/api/verse/intent/other')).toBe(false);
  });

  it('reports an absent ledger as not present and does not create one', async () => {
    const r = await call('GET', INTENT_PATH);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, schema: INTENT_LEDGER_SCHEMA, present: false, items: 0, records: [] });
    expect(existsSync(ledgerDir())).toBe(false);
  });

  it('returns summary and records from one snapshot, preserving provenance, without mutating', async () => {
    const items = [
      item('a1', { rq: ['RQ-FAKE-ONE'], lastTouchedAt: OLD }),
      item('b2', { status: 'shipped', lastTouchedAt: OLD }),
      item('c3', { rq: ['RQ-FAKE-TWO'], partial: true }),
    ];
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(ledgerFile(), `${JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items })}\n`);
    const before = readFileSync(ledgerFile(), 'utf8');
    const r = await call('GET', INTENT_PATH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, present: true, items: 3, tracked: 2, stale: 1, shipped: 1, partial: 1 });
    expect(r.body.records).toHaveLength(r.body.items);
    expect(r.body.staleItems.map((s: { id: string }) => s.id)).toEqual(['a1']);
    expect(r.body.records[0].provenance).toEqual(items[0]!.provenance);
    expect(readFileSync(ledgerFile(), 'utf8')).toBe(before);
  });

  it('answers a corrupt ledger with a controlled 503 and no records', async () => {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(ledgerFile(), '{ not json');
    const r = await call('GET', INTENT_PATH);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'intent ledger unavailable', records: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/at |stack|ledger\.json/);
  });

  it('refuses non-GET methods and leaves other routes unhandled', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await call(method, INTENT_PATH);
      expect(r.status).toBe(405);
    }
    expect(existsSync(ledgerDir())).toBe(false);
    const unknown = await call('GET', '/api/verse/unknown');
    expect(unknown.handled).toBe(false);
    expect(unknown.status).toBe(0);
  });
});
