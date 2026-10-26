/**
 * Flagship slice 3: per-run routing accounting, the status --json routing
 * block, and the doctor routing row. Hermetic: temp files only, no real
 * ~/.ashlr and no model endpoint except an injected fetch.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRouting } from '../src/core/doctor.js';
import {
  readRoutingStatus,
  recordTerminalRunRouting,
  routingSplitDetail,
  routingStatusFrom,
  type RoutingAccountLine,
  type RoutingStatus,
} from '../src/core/routing/routing-account.js';
import type { AshlrConfig, AshlrIndex } from '../src/core/types.js';
import { gatherStatus, type StatusLoaders } from '../src/cli/status.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routing-account-'));
  dirs.push(dir);
  return dir;
}

const NOW = new Date('2026-10-26T12:00:00.000Z');
const cfgOf = (localInference: unknown) => ({ localInference }) as unknown as AshlrConfig;
const up = async () => new Response(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }), { status: 200 });

function line(partial: Pick<RoutingAccountLine, 'at' | 'runId' | 'route' | 'escalationReason' | 'engineId'> & {
  localIn?: number; localOut?: number; frontierIn?: number; frontierOut?: number;
}): RoutingAccountLine {
  const tokens = {
    local: { in: partial.localIn ?? 0, out: partial.localOut ?? 0 },
    frontier: { in: partial.frontierIn ?? 0, out: partial.frontierOut ?? 0 },
  };
  return {
    v: 1,
    type: 'routing-account',
    at: partial.at,
    runId: partial.runId,
    route: partial.route,
    escalationReason: partial.escalationReason,
    engineId: partial.engineId,
    tokens,
    frontierTokensSaved: partial.route === 'local' ? tokens.local.in + tokens.local.out : 0,
  };
}

const GOLDEN: RoutingStatus = {
  schemaVersion: 1,
  windowHours: 24,
  split: { local: 1, frontier: 1 },
  tokens: { local: { in: 100, out: 20 }, frontier: { in: 5, out: 7 } },
  frontierTokensSaved: 120,
  runs: [
    line({ at: '2026-10-26T11:30:00.000Z', runId: 'run-b', route: 'frontier', escalationReason: 'policy-off', engineId: 'claude', frontierIn: 5, frontierOut: 7 }),
    line({ at: '2026-10-26T11:00:00.000Z', runId: 'run-a', route: 'local', escalationReason: 'local-ok', engineId: 'local-coder', localIn: 100, localOut: 20 }),
  ],
  ledger: null,
};

describe('status --json routing block', () => {
  it('matches the golden last-24h local/frontier split', () => {
    const lines = [
      line({ at: '2026-10-25T10:00:00.000Z', runId: 'stale', route: 'local', escalationReason: 'local-ok', engineId: 'local-coder', localIn: 1000, localOut: 1000 }),
      line({ at: '2026-10-26T10:00:00.000Z', runId: 'run-a', route: 'local', escalationReason: 'local-ok', engineId: 'local-coder', localIn: 1, localOut: 1 }),
      line({ at: '2026-10-26T11:00:00.000Z', runId: 'run-a', route: 'local', escalationReason: 'local-ok', engineId: 'local-coder', localIn: 100, localOut: 20 }),
      line({ at: '2026-10-26T11:30:00.000Z', runId: 'run-b', route: 'frontier', escalationReason: 'policy-off', engineId: 'claude', frontierIn: 5, frontierOut: 7 }),
    ];
    const block = routingStatusFrom(lines, null, NOW);
    expect(JSON.parse(JSON.stringify(block))).toEqual(GOLDEN);
    expect(routingSplitDetail(block)).toBe('local 1 / frontier 1; frontier tokens saved 120');
  });

  it('round-trips the golden block through the accounting file', () => {
    const path = join(scratch(), 'accounting.jsonl');
    expect(recordTerminalRunRouting(
      { id: 'run-a', engine: 'local-coder', status: 'done', usage: { tokensIn: 1, tokensOut: 1 }, routeSnapshot: { reason: 'local-ok' } },
      {},
      { now: new Date('2026-10-26T10:00:00.000Z'), path },
    )).toBe(true);
    expect(recordTerminalRunRouting(
      { id: 'run-a', engine: 'local-coder', status: 'done', usage: { tokensIn: 100, tokensOut: 20 }, routeSnapshot: { reason: 'local-ok' } },
      {},
      { now: new Date('2026-10-26T11:00:00.000Z'), path },
    )).toBe(true);
    expect(recordTerminalRunRouting(
      { id: 'run-b', engine: 'claude', status: 'done', usage: { tokensIn: 5, tokensOut: 7 } },
      {},
      { now: new Date('2026-10-26T11:30:00.000Z'), path },
    )).toBe(true);
    expect(recordTerminalRunRouting(
      { id: 'stale', engine: 'local-coder', status: 'done', usage: { tokensIn: 1000, tokensOut: 1000 } },
      {},
      { now: new Date('2026-10-25T10:00:00.000Z'), path },
    )).toBe(true);
    expect(readRoutingStatus({ now: NOW, accountPath: path, ledgerPath: join(scratch(), 'missing-ledger.json') })).toEqual(GOLDEN);
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(4);
    for (const row of raw) expect(JSON.parse(row).type).toBe('routing-account');
  });

  it('is the routing key gatherStatus puts on phm status --json', async () => {
    const home = scratch();
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const path = join(home, '.ashlr', 'routing', 'accounting.jsonl');
      mkdirSync(join(home, '.ashlr', 'routing'), { recursive: true });
      const rows = [
        line({ at: '2026-10-26T11:00:00.000Z', runId: 'run-a', route: 'local', escalationReason: 'local-ok', engineId: 'local-coder', localIn: 100, localOut: 20 }),
        line({ at: '2026-10-26T11:30:00.000Z', runId: 'run-b', route: 'frontier', escalationReason: 'policy-off', engineId: 'claude', frontierIn: 5, frontierOut: 7 }),
      ];
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const loaders: StatusLoaders = {
        getToolsRegistry: async () => null,
        discoverMcpServers: async () => null,
        buildRollup: async () => null,
        githubStatus: async () => null,
        vercelStatus: async () => null,
        getIdentity: async () => null,
      };
      const cfg = { version: 1, roots: [], staleDays: 30 } as unknown as AshlrConfig;
      const idx = { items: [] } as unknown as AshlrIndex;
      const realNow = Date.now;
      Date.now = () => NOW.getTime();
      try {
        const status = await gatherStatus(cfg, idx, loaders, home);
        expect(JSON.parse(JSON.stringify(status.routing))).toEqual(GOLDEN);
      } finally {
        Date.now = realNow;
      }
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevProfile;
    }
  });
});

describe('routing decisions', () => {
  it('gives an unknown engine id no local route and no frontier tokens saved', () => {
    const path = join(scratch(), 'accounting.jsonl');
    recordTerminalRunRouting(
      { id: 'run-m', engine: 'mystery-engine', status: 'done', usage: { tokensIn: 50, tokensOut: 10 }, routeSnapshot: { reason: 'local-ok' } },
      {},
      { now: NOW, path },
    );
    const line = readRoutingStatus({ now: NOW, accountPath: path, ledgerPath: join(scratch(), 'nope.json') }).runs[0];
    expect(line).toMatchObject({
      route: 'frontier',
      escalationReason: 'unclassified',
      engineId: 'mystery-engine',
      frontierTokensSaved: 0,
      tokens: { local: { in: 0, out: 0 }, frontier: { in: 50, out: 10 } },
    });
  });

  it('does not record a run that is still going, and does not write a receipt', () => {
    const root = scratch();
    const path = join(root, 'routing', 'accounting.jsonl');
    expect(recordTerminalRunRouting(
      { id: 'run-live', engine: 'claude', status: 'running', usage: { tokensIn: 9, tokensOut: 9 } },
      {},
      { path },
    )).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('redaction', () => {
  it('never writes a token or key into the accounting line', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const phm = 'phm_live_secret_token_value';
    const path = join(scratch(), 'accounting.jsonl');
    expect(recordTerminalRunRouting({
      id: `run-${secret}`,
      engine: phm,
      status: 'done',
      usage: { tokensIn: 4, tokensOut: 1 },
      routeSnapshot: { reason: `API_KEY=${secret}` },
    }, {}, { now: NOW, path })).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(phm);
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('sk-');
    const parsed = JSON.parse(text) as RoutingAccountLine;
    expect(parsed.runId).toBe('redacted');
    expect(parsed.engineId).toBe('redacted');
    expect(parsed.route).toBe('frontier');
    expect(parsed.escalationReason).toBe('unclassified');
  });
});

describe('doctor routing row', () => {
  function seed(path: string): void {
    recordTerminalRunRouting(
      { id: 'run-a', engine: 'local-coder', status: 'done', usage: { tokensIn: 100, tokensOut: 20 }, routeSnapshot: { reason: 'local-ok' } },
      {},
      { now: new Date('2026-10-26T11:00:00.000Z'), path },
    );
    recordTerminalRunRouting(
      { id: 'run-b', engine: 'claude', status: 'done', usage: { tokensIn: 5, tokensOut: 7 } },
      {},
      { now: new Date('2026-10-26T11:30:00.000Z'), path },
    );
  }

  it('passes when the loopback endpoint is up and shows the 24h split', async () => {
    const path = join(scratch(), 'accounting.jsonl');
    seed(path);
    const row = await checkRouting(cfgOf({ provider: 'ollama', routing: 'hybrid', models: { coder: 'qwen3-coder' } }), {
      fetchImpl: up, now: NOW, accountPath: path,
    });
    expect(row.status).toBe('pass');
    expect(row.detail).toContain('loopback ollama up (hybrid)');
    expect(row.detail).toContain('local 1 / frontier 1; frontier tokens saved 120');
  });

  it('warns when localInference is absent', async () => {
    const path = join(scratch(), 'accounting.jsonl');
    seed(path);
    const row = await checkRouting(cfgOf(undefined), { fetchImpl: up, now: NOW, accountPath: path });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('localInference absent');
    expect(row.detail).toContain('frontier tokens saved 120');
  });

  it('warns when the loopback endpoint is down', async () => {
    const row = await checkRouting(cfgOf({ provider: 'ollama', routing: 'hybrid', models: { coder: 'q' } }), {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      now: NOW,
      accountPath: join(scratch(), 'missing.jsonl'),
    });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('loopback endpoint down');
    expect(row.detail).toContain('local 0 / frontier 0; frontier tokens saved 0');
  });

  it('refuses a non-loopback endpoint and does not contact it', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response('{}', { status: 200 }); };
    const remote = await checkRouting(cfgOf({
      provider: 'openai-compat', baseUrl: 'https://llm.example.com/v1', allowRemote: true,
    }), { fetchImpl, now: NOW, accountPath: join(scratch(), 'missing.jsonl') });
    expect(remote.status).toBe('warn');
    expect(remote.detail).toContain('not loopback');
    expect(remote.detail).toContain('not contacted');
    expect(calls).toBe(0);

    const lan = await checkRouting(cfgOf({
      provider: 'openai-compat', baseUrl: 'http://10.1.1.1:11434/v1',
    }), { fetchImpl });
    expect(lan.status).toBe('warn');
    expect(calls).toBe(0);

    const otherLoop = await checkRouting(cfgOf({
      provider: 'openai-compat', baseUrl: 'http://127.0.0.2:11434/v1',
    }), { fetchImpl });
    expect(otherLoop.status).toBe('warn');
    expect(calls).toBe(0);
  });

  it('contacts ::1 and 127.0.0.1 only', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => { seen.push(url); return up(); };
    const v6 = await checkRouting(cfgOf({
      provider: 'openai-compat', baseUrl: 'http://[::1]:11434/v1', routing: 'hybrid', models: { coder: 'q' },
    }), { fetchImpl, now: NOW, accountPath: join(scratch(), 'missing.jsonl') });
    expect(v6.status).toBe('pass');
    expect(seen.some((url) => url.includes('[::1]') || url.includes('::1'))).toBe(true);

    seen.length = 0;
    await checkRouting(cfgOf({ provider: 'ollama' }), { fetchImpl, now: NOW, accountPath: join(scratch(), 'missing.jsonl') });
    expect(seen.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('does not fail under the doctor exit rule (warnings stay warnings, including --strict)', async () => {
    const rows = await Promise.all([
      checkRouting(cfgOf(undefined)),
      checkRouting(cfgOf('nope')),
      checkRouting(cfgOf({ provider: 'openai-compat', baseUrl: 'https://llm.example.com/v1', allowRemote: true }), {
        fetchImpl: async () => { throw new Error('must not be called'); },
      }),
      checkRouting(cfgOf({ provider: 'ollama', routing: 'hybrid', models: { coder: 'q' } }), {
        fetchImpl: async () => { throw new Error('down'); },
      }),
    ]);
    for (const row of rows) {
      expect(row.status).toBe('warn');
      // phm doctor exits 1 only when summary.fail > 0. --strict does not promote this row.
      expect(row.status === 'fail' ? 1 : 0).toBe(0);
    }
  });
});
