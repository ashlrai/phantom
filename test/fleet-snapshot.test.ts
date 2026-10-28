import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { embeddedSchedulerConfig } from '../src/core/providers/coding-cli/scheduler/defaults.js';
import { join } from 'node:path';
import { buildCodingFleetSnapshot, codingFleetPath, FLEET_POOL_IDS, formatCodingFleetSnapshot, readCodingFleetSnapshot, writeCodingFleetSnapshot, } from '../src/core/fleet/coding-snapshot.js';
import { appendSpendDecision, type SpendDecision } from '../src/core/providers/coding-cli/ledger.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
const readRace = vi.hoisted(() => ({
  foreignParent: null as string | null,
  beforeOpen: null as null | ((path: unknown) => void)
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      if (args[0] === readRace.foreignParent && typeof stat.uid === 'number') stat.uid += 1;
      return stat;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      readRace.beforeOpen?.(args[0]);
      return actual.openSync(...args);
    },
  };
});
const NOW = Date.parse('2026-10-26T12:00:00Z');
const dirs: string[] = [];
function setup(input?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-snapshot-'));
  dirs.push(dir);
  const path = join(dir, 'fleet.json');
  const home = join(dir, 'home');
  mkdirSync(home, {
    mode: 0o700
  });
  if (input !== undefined)
    writeFileSync(path, JSON.stringify(input), {
      mode: 0o600
    });
  return {
    dir,
    path,
    home,
    nowMs: NOW,
    fetchGithub: false
  };
}
type AttributedSpend = SpendDecision & { repo?: string; pr?: number };
function spend(overrides: Partial<AttributedSpend> = {}): AttributedSpend {
  return {
    ts: '2026-10-26T11:00:00Z',
    poolId: 'codex-primary',
    billing: 'subscription',
    balanceKnown: false,
    expiryKnown: false,
    complexity: 'medium',
    risk: 'low',
    backend: 'codex',
    accountId: null,
    model: null,
    escalations: 0,
    verification: 'passed',
    ci: 'passed',
    merged: true,
    timeMs: 1000,
    quota: null,
    cost: 2,
    ...overrides
  };
}
afterEach(() => {
  readRace.beforeOpen = null;
  readRace.foreignParent = null;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true
    });
});
describe('fleet.v1 coding snapshot', () => {
  it('matches the published fleet.v1 fixture and schema surface', async () => {
    const snapshot = await buildCodingFleetSnapshot(setup());
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/fleet/fleet.v1.json', import.meta.url), 'utf8'));
    const schema = JSON.parse(readFileSync(new URL('../schema/fleet.v1.schema.json', import.meta.url), 'utf8'));
    expect(snapshot).toEqual(fixture);
    expect(Object.keys(snapshot).sort()).toEqual(schema.required.slice().sort());
    expect(schema.properties.pools.items.properties.id.enum).toEqual([...FLEET_POOL_IDS]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.pools.items.additionalProperties).toBe(false);
  });
  it('shows unclaimed Verse agents with an unknown current task without exporting prompts or plan text', async () => {
    const opts = setup();
    mkdirSync(join(opts.home, 'verse', 'agents'), {
      recursive: true,
      mode: 0o700
    });
    writeFileSync(join(opts.home, 'verse', 'agents', 'agents.json'), JSON.stringify({
      agents: [{
          id: 'ag_12345678',
          workspace: {
            rootPath: '/private/work/phantom'
          },
          pendingPrompt: 'private prompt',
          plan: {
            text: 'private plan'
          },
          archived: null
        }]
    }), {
      mode: 0o600
    });
    const snapshot = await buildCodingFleetSnapshot(opts);
    expect(snapshot.agents).toEqual([{
        agent: 'ag_12345678',
        repo: 'unknown',
        task: 'unknown',
        claim_id: null,
        expires_at: null
      }]);
    expect(JSON.stringify(snapshot)).not.toContain('private prompt');
    expect(JSON.stringify(snapshot)).not.toContain('private plan');
  });
  it('has stable eight-pool schema and explicitly unknown missing data', async () => {
    const snapshot = await buildCodingFleetSnapshot(setup());
    expect(snapshot.schema).toBe('fleet.v1');
    expect(snapshot.pools.map(p => p.id)).toEqual(FLEET_POOL_IDS);
    expect(snapshot.pools.find(p => p.id === 'codex-cmp')).toMatchObject({
      source: 'unknown',
      used_pct: null,
      remaining_pct: null,
      runway_hours: null,
      projected_pct: null,
      reset_at: null
    });
    expect(snapshot.agents).toBeNull();
    expect(snapshot.router.regret).toBeNull();
    expect(snapshot.repos).toHaveLength(7);
    expect(snapshot.repos.every(repo => repo.open === null && repo.merged === null && repo.source === 'unknown')).toBe(true);
    expect(formatCodingFleetSnapshot(snapshot)).toContain('unknown');
    expect(snapshot.pools.find(p => p.id === 'grok-ultra-weekly')).toMatchObject({
      source: 'estimate',
      used_pct: 36,
      actual: [],
      projected_pct: null
    });
    expect(snapshot.pools.find(p => p.id === 'cursor')).toMatchObject({
      source: 'unknown',
      used_pct: null,
      shared_with: 'grok-ultra-weekly'
    });
  });
  it('preserves manual readings, each age, rate, ideal pace and labelled projection through atomic roundtrip', async () => {
    const input = {
      readings: [{
          pool: 'codex-primary',
          used_pct: 20,
          at: '2026-10-26T08:00:00Z',
          source: 'manual'
        }, {
          pool: 'codex-cmp',
          used_pct: 30,
          at: '2026-10-26T10:00:00Z',
          source: 'manual'
        }],
      windows: [{
          pool: 'codex-cmp',
          start: '2026-10-26T00:00:00Z',
          reset: '2026-10-27T00:00:00Z'
        }]
    };
    const opts = setup(input);
    const snapshot = await buildCodingFleetSnapshot(opts);
    const p = snapshot.pools.find(p => p.id === 'codex-cmp');
    expect(p).toMatchObject({
      source: 'manual',
      used_pct: 30,
      remaining_pct: 70,
      age_seconds: 7200,
      burn_pct_per_hour: 5,
      runway_hours: 12,
      ideal_pct: 50,
      projected_pct: 100,
      uncertainty: 'linear estimate; future usage unknown'
    });
    expect(snapshot.readings.map(r => r.age_seconds)).toEqual([14400, 7200]);
    writeCodingFleetSnapshot(snapshot, opts.path);
    expect(readCodingFleetSnapshot(opts.path, {
      nowMs: NOW
    })).toEqual(snapshot);
    expect((await buildCodingFleetSnapshot(opts)).readings).toEqual(snapshot.readings);
    expect(readFileSync(opts.path, 'utf8')).not.toContain('undefined');
  });
  it('does not treat zero usage, a single reading, counter reversal or future reading as a measured rate', async () => {
    const opts = setup({
      readings: [{
          pool: 'devin',
          used_pct: 0,
          at: '2026-10-26T09:00:00Z',
          source: 'manual'
        }, {
          pool: 'grok-build',
          used_pct: 40,
          at: '2026-10-26T08:00:00Z',
          source: 'manual'
        }, {
          pool: 'grok-build',
          used_pct: 20,
          at: '2026-10-26T10:00:00Z',
          source: 'manual'
        }, {
          pool: 'cursor',
          used_pct: 99,
          at: '2026-10-27T00:00:00Z',
          source: 'manual'
        }, {
          pool: 'omlx',
          used_pct: 101,
          at: '2026-10-26T10:00:00Z',
          source: 'manual'
        }]
    });
    const s = await buildCodingFleetSnapshot(opts);
    expect(s.pools.find(p => p.id === 'devin')).toMatchObject({
      used_pct: 0,
      remaining_pct: 100,
      burn_pct_per_hour: null
    });
    expect(s.pools.find(p => p.id === 'grok-build')?.burn_pct_per_hour).toBeNull();
    expect(s.readings).toHaveLength(3);
  });
  it('follows weekly wall-clock reset across DST and clears old-window observations', async () => {
    const opts = setup({
      readings: [{
          pool: 'grok-ultra-weekly',
          used_pct: 80,
          at: '2026-10-25T12:00:00Z',
          source: 'manual'
        }]
    });
    const s = await buildCodingFleetSnapshot({
      ...opts,
      nowMs: Date.parse('2026-10-31T12:00:00Z')
    });
    expect(s.windows.find(w => w.pool === 'grok-ultra-weekly')).toMatchObject({
      start: '2026-10-26T00:21:00.000Z',
      reset: '2026-11-02T01:21:00.000Z'
    });
    expect(s.pools.find(p => p.id === 'grok-ultra-weekly')?.actual).toEqual([]);
    const next = await buildCodingFleetSnapshot({
      ...opts,
      nowMs: Date.parse('2026-11-02T12:00:00Z')
    });
    expect(next.windows.find(w => w.pool === 'grok-ultra-weekly')?.reset).toBe('2026-11-09T01:21:00.000Z');
    expect(next.pools.find(p => p.id === 'grok-ultra-weekly')?.used_pct).toBeNull();
  });
  it('retains parent planner series when present, degrades otherwise and preserves it across refresh', async () => {
    const opts = setup({
      planner: {
        series: {
          'codex-cmp': [{
              at: '2026-10-27T12:00:00Z',
              used_pct: 80
            }]
        }
      }
    });
    const s = await buildCodingFleetSnapshot(opts);
    expect(s.pools.find(p => p.id === 'codex-cmp')?.planner).toHaveLength(1);
    writeCodingFleetSnapshot(s, opts.path);
    const refreshed = await buildCodingFleetSnapshot(opts);
    expect(refreshed.pools.find(p => p.id === 'codex-cmp')?.planner).toEqual(s.pools.find(p => p.id === 'codex-cmp')?.planner);
  });
  it('reports corrupt and unreadable sources unknown without leaking errors or silently zeroing them', async () => {
    const opts = setup();
    writeFileSync(opts.path, '{invalid', {
      mode: 0o600
    });
    mkdirSync(join(opts.home, 'router'));
    writeFileSync(join(opts.home, 'router', 'decisions.jsonl'), 'not json', {
      mode: 0o600
    });
    const s = await buildCodingFleetSnapshot(opts);
    expect(s.sources.shared).toBe('unknown');
    expect(s.router.decisions).toBeNull();
    expect(s.router.source).toBe('partial');
    expect(readCodingFleetSnapshot(opts.path)).toBeNull();
    rmSync(opts.path);
    symlinkSync(join(opts.home, 'router', 'decisions.jsonl'), opts.path);
    expect(readCodingFleetSnapshot(opts.path)).toBeNull();
  });
  it('uses read-only bounded gh lists, preserves partial failures and explicit per-PR cost identity', async () => {
    const opts = setup();
    mkdirSync(join(opts.home, 'router'));
    const path = join(opts.home, 'router', 'spend.jsonl');
    appendFileSync(path, JSON.stringify(spend({
      repo: 'ashlrai/phantom',
      pr: 42,
      cost: 2
    })) + '\n', { mode: 0o600 });
    appendFileSync(path, JSON.stringify(spend({
      repo: 'ashlrai/phantom',
      pr: 42,
      cost: 3
    })) + '\n');
    appendSpendDecision(path, spend({
      cost: 100
    }));
    const gh = vi.fn(async (args: string[]) => {
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      expect(args).toContain('--limit');
      if (args.includes('ashlrai/locus'))
        throw new Error('permission denied token=should-not-appear');
      return [{
          number: 42,
          title: 'Improve fleet',
          statusCheckRollup: [{
              conclusion: 'SUCCESS',
              status: 'COMPLETED'
            }]
        }];
    });
    const s = await buildCodingFleetSnapshot({
      ...opts,
      fetchGithub: true,
      gh
    });
    expect(gh).toHaveBeenCalledTimes(14);
    expect(s.repos.find((repo) => repo.repo === 'ashlrai/locus')?.source).toBe('unknown');
    expect(s.sources.github).toBe('partial');
    expect(s.repos.find(r => r.repo === 'ashlrai/phantom')?.merged?.[0]).toMatchObject({
      number: 42,
      ci: 'passed',
      cost: [{
          pool: 'codex-cmp',
          value: 5,
          unit: 'pool-unit'
        }]
    });
    expect(s.repos.find(r => r.repo === 'ashlrai/lexicon')?.merged?.[0]?.cost).toBeNull();
    expect(JSON.stringify(s)).not.toContain('permission denied');
  });
  it('does not report unknown linked costs as zero; rejects malformed PR identities', async () => {
    const opts = setup();
    mkdirSync(join(opts.home, 'router'));
    const path = join(opts.home, 'router', 'spend.jsonl');
    writeFileSync(path, JSON.stringify(spend({
      repo: 'ashlrai/phantom',
      pr: 1,
      cost: null
    })) + '\n', { mode: 0o600 });
    const s = await buildCodingFleetSnapshot({
      ...opts,
      fetchGithub: true,
      gh: async () => [{
          number: 1,
          title: 'test',
          statusCheckRollup: []
        }]
    });
    expect(s.repos[0].merged?.[0]?.cost).toBeNull();
    for (const identity of [
      { repo: 'ashlrai/phantom', pr: 0 },
      { repo: 'ashlrai/phantom' },
      { pr: 1 },
      { repo: '../phantom', pr: 1 },
    ]) {
      writeFileSync(path, JSON.stringify(spend(identity)) + '\n');
      const invalid = await buildCodingFleetSnapshot({
        ...opts, fetchGithub: true, gh: async () => [{ number: 1, title: 'test' }],
      });
      expect(invalid.sources.spend).toBe('unknown');
      expect(invalid.repos[0].merged?.[0]?.cost).toBeNull();
    }
  });
  it('distinguishes GitHub pending, failed, unknown and truncated lists', async () => {
    const opts = setup();
    const entries = [{
        number: 1,
        title: 'a',
        statusCheckRollup: [{
            state: 'PENDING'
          }]
      }, {
        number: 2,
        title: 'b',
        statusCheckRollup: [{
            conclusion: 'FAILURE'
          }]
      }, {
        number: 3,
        title: 'c',
        statusCheckRollup: []
      }];
    const s = await buildCodingFleetSnapshot({
      ...opts,
      fetchGithub: true,
      gh: async () => entries
    });
    expect(s.repos[0].open?.map(p => p.ci)).toEqual(['pending', 'failed', 'unknown']);
    const full = await buildCodingFleetSnapshot({
      ...opts,
      fetchGithub: true,
      gh: async () => Array.from({
        length: 100
      }, (_, i) => ({
        number: i + 1,
        title: 'PR'
      }))
    });
    expect(full.repos[0].complete).toBe(false);
  });
  it('uses live claims for tasks without exposing bearer lease material', async () => {
    const opts = setup();
    const result = claimFleetWork({
      repo: 'ashlrai/phantom',
      task: 'Review snapshot',
      agent: 'codex'
    }, {
      path: join(opts.home, 'fleet', 'coordination.jsonl'),
      now: NOW
    });
    expect(result.ok).toBe(true);
    const s = await buildCodingFleetSnapshot(opts);
    expect(s.agents?.[0]).toMatchObject({
      agent: 'codex',
      repo: 'ashlrai/phantom',
      task: 'Review snapshot',
      expires_at: '2026-10-26T13:00:00.000Z'
    });
    expect(JSON.stringify(s)).not.toContain('leaseHash');
    if (result.ok)
      expect(JSON.stringify(s)).not.toContain(result.value.lease);
  });
  it('redacts secrets, tokens, environment values and arbitrary injected fields across saved JSON and remote reads', async () => {
    const opaque = 'opaqueCredentialWithNoKnownPrefix123';
    const envValue = 'myPrivateEnvironmentValue987';
    vi.stubEnv('SOME_INNOCENT_NAME', envValue);
    const token = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const opts = setup({
      apiKey: opaque,
      readings: [{
          pool: 'devin',
          used_pct: 10,
          at: '2026-10-26T10:00:00Z',
          source: 'manual',
          secret: opaque
        }]
    });
    const s = await buildCodingFleetSnapshot({
      ...opts,
      knownSecrets: [opaque],
      fetchGithub: true,
      gh: async () => [{
          number: 1,
          title: `Task ${opaque} ${token} ${envValue}`,
          body: 'raw CLI output',
          authFile: 'private',
          statusCheckRollup: []
        }],
      coordination: {
        state: 'known',
        claims: [{
            id: '1',
            repo: 'ashlrai/phantom',
            agent: 'codex',
            task: `${opaque} ${envValue}`,
            claimedAt: NOW,
            expiresAt: NOW + 1000,
            lease: 'never-export'
          }],
        messages: [],
        proposals: [],
        expiredClaims: 0
      }
    });
    const encoded = JSON.stringify(s);
    for (const secret of [opaque, token, envValue, 'raw CLI output', 'authFile', 'never-export'])
      expect(encoded).not.toContain(secret);
    writeCodingFleetSnapshot(s, opts.path);
    const raw = JSON.parse(readFileSync(opts.path, 'utf8'));
    raw.authFile = 'private contents';
    raw.repos[0].open[0].token = 'injected';
    raw.pools[0].rawCLI = 'raw usage text';
    writeFileSync(opts.path, JSON.stringify(raw), {
      mode: 0o600
    });
    const clean = JSON.stringify(readCodingFleetSnapshot(opts.path, {
      nowMs: NOW,
      knownSecrets: [opaque]
    }));
    for (const secret of ['private contents', 'injected', 'raw usage text'])
      expect(clean).not.toContain(secret);
  });
  it('redacts short explicit credentials and private scheduler keys', async () => {
    const opts = setup();
    vi.stubEnv('PASSWORD', 'short7');
    const snapshot = await buildCodingFleetSnapshot({
      ...opts,
      knownSecrets: ['other6'],
      fetchGithub: true,
      gh: async () => [{
          number: 1,
          title: 'short7 other6',
          statusCheckRollup: []
        }]
    });
    expect(JSON.stringify(snapshot)).not.toContain('short7');
    expect(JSON.stringify(snapshot)).not.toContain('other6');
  });
  it('does not invent a fresh timestamp for malformed persisted snapshots and hides expired claims', async () => {
    const opts = setup();
    const snapshot = await buildCodingFleetSnapshot({
      ...opts,
      coordination: {
        state: 'known',
        claims: [{
            id: 'claim',
            repo: 'ashlrai/phantom',
            agent: 'codex',
            task: 'done',
            claimedAt: NOW,
            expiresAt: NOW + 1000
          }],
        messages: [],
        proposals: [],
        expiredClaims: 0
      }
    });
    writeCodingFleetSnapshot(snapshot, opts.path);
    const later = readCodingFleetSnapshot(opts.path, {
      nowMs: NOW + 2000
    });
    expect(later?.agents).toEqual([]);
    expect(later?.coordination.claims).toEqual([]);
    const raw = JSON.parse(readFileSync(opts.path, 'utf8'));
    delete raw.generated_at;
    writeFileSync(opts.path, JSON.stringify(raw), {
      mode: 0o600
    });
    expect(readCodingFleetSnapshot(opts.path, {
      nowMs: NOW + 2000
    })).toBeNull();
  });
  it('rejects a FIFO substituted between lstat and open without blocking', async () => {
    const opts = setup();
    const snapshot = await buildCodingFleetSnapshot(opts);
    writeCodingFleetSnapshot(snapshot, opts.path);
    let substituted = false;
    readRace.beforeOpen = (path) => {
      if (path !== opts.path || substituted)
        return;
      substituted = true;
      rmSync(opts.path);
      execFileSync('/usr/bin/mkfifo', [opts.path]);
    };
    expect(readCodingFleetSnapshot(opts.path, {
      nowMs: NOW
    })).toBeNull();
    expect(substituted).toBe(true);
  });
  it('preserves signed router decision values and rejects non-finite values', async () => {
    const opts = setup();
    mkdirSync(join(opts.home, 'router'));
    const decision = {
      ts: '2026-10-26T11:00:00Z',
      jobId: 'job',
      jobType: 'coding',
      poolId: 'codex-primary',
      consumer: null,
      policyId: 'incumbent',
      canary: false,
      propensity: 1,
      solver: 'greedy',
      fallback: true,
      grantsMergeAuthority: false,
      netValue: -2.5,
      eligible: []
    };
    writeFileSync(join(opts.home, 'router', 'decisions.jsonl'), JSON.stringify(decision) + '\n', {
      mode: 0o600
    });
    const snapshot = await buildCodingFleetSnapshot(opts);
    expect(snapshot.router.decisions?.[0]?.netValue).toBe(-2.5);
    expect(snapshot.router.decisions?.[0]?.consumer).toBeNull();
    expect(snapshot.router.decisions?.[0]?.grantsMergeAuthority).toBe(false);
  });
  it('keeps a configured estimate during the DST boundary hour instead of inventing zero', async () => {
    const opts = setup();
    const config = embeddedSchedulerConfig();
    config.grokUltraWeekly.usedFractionAsOf = '2026-10-26T00:45:00Z';
    const snapshot = await buildCodingFleetSnapshot({
      ...opts,
      nowMs: Date.parse('2026-10-26T01:00:00Z'),
      schedulerConfig: config
    });
    expect(snapshot.pools.find((p) => p.id === 'grok-ultra-weekly')).toMatchObject({
      used_pct: 36,
      source: 'estimate'
    });
  });
  it('keeps the newest router rows and marks a capped projection partial', async () => {
    const opts = setup();
    mkdirSync(join(opts.home, 'router'));
    const decisions = Array.from({ length: 1001 }, (_, index) => ({
      ts: '2026-10-26T11:00:00Z', jobId: `job-${index}`, jobType: 'coding', poolId: 'codex-primary', consumer: null,
      policyId: 'incumbent', canary: false, propensity: 1, solver: 'greedy', fallback: true,
      grantsMergeAuthority: false, netValue: 1, eligible: [],
    }));
    writeFileSync(join(opts.home, 'router', 'decisions.jsonl'), decisions.map((decision) => JSON.stringify(decision)).join('\n') + '\n', { mode: 0o600 });
    writeFileSync(join(opts.home, 'router', 'outcomes.jsonl'), '', { mode: 0o600 });
    const snapshot = await buildCodingFleetSnapshot(opts);
    expect(snapshot.router.decisions).toHaveLength(1000);
    expect(snapshot.router.decisions?.[0]?.jobId).toBe('job-1');
    expect(snapshot.router.decisions?.at(-1)?.jobId).toBe('job-1000');
    expect(snapshot.router.source).toBe('partial');
    expect(snapshot.sources.router).toBe('partial');
    writeCodingFleetSnapshot(snapshot, opts.path);
    expect(readCodingFleetSnapshot(opts.path, { nowMs: NOW })?.router.source).toBe('partial');
  });
  it('refuses publication into writable or foreign-owned directories', async () => {
    const opts = setup();
    const snapshot = await buildCodingFleetSnapshot(opts);
    chmodSync(opts.dir, 0o777);
    expect(() => writeCodingFleetSnapshot(snapshot, opts.path)).toThrow('owned private directory');
    expect(readCodingFleetSnapshot(opts.path)).toBeNull();
    chmodSync(opts.dir, 0o700);
    if (typeof process.getuid === 'function') {
      readRace.foreignParent = opts.dir;
      expect(() => writeCodingFleetSnapshot(snapshot, opts.path)).toThrow('owned private directory');
      readRace.foreignParent = null;
    }
    expect(readCodingFleetSnapshot(opts.path)).toBeNull();
  });
  it('preserves the previous snapshot when the projected document exceeds the read limit', async () => {
    const opts = setup();
    const snapshot = await buildCodingFleetSnapshot(opts);
    writeCodingFleetSnapshot(snapshot, opts.path);
    const before = readFileSync(opts.path, 'utf8');
    const text = 'x'.repeat(240);
    const date = new Date(NOW).toISOString();
    const expires = new Date(NOW + 60_000).toISOString();
    const oversized = { ...snapshot, coordination: { state: 'known' as const, expiredClaims: 0,
      claims: Array.from({ length: 1000 }, () => ({ id: text, repo: text, task: text, agent: text, claimedAt: date, expiresAt: expires })),
      messages: Array.from({ length: 1000 }, () => ({ id: text, from: text, to: text, body: 'x'.repeat(2000), at: date, expiresAt: expires })),
      proposals: Array.from({ length: 1000 }, () => ({ id: text, repo: text, task: text, to: text, at: date, expiresAt: expires })),
    } };
    expect(() => writeCodingFleetSnapshot(oversized, opts.path)).toThrow('exceeds byte limit');
    expect(readFileSync(opts.path, 'utf8')).toBe(before);
    expect(readCodingFleetSnapshot(opts.path, { nowMs: NOW })).toEqual(snapshot);
  });
  it('keeps a private atomically published file and supports configured shared path', async () => {
    const opts = setup();
    vi.stubEnv('PHANTOM_FLEET_PATH', opts.path);
    expect(codingFleetPath()).toBe(opts.path);
    const s = await buildCodingFleetSnapshot(opts);
    writeCodingFleetSnapshot(s);
    expect(readCodingFleetSnapshot(undefined, {
      nowMs: NOW
    })).toEqual(s);
    chmodSync(opts.path, 0o600);
  });
});
