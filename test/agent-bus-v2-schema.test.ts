import { describe, expect, it } from 'vitest';
import {
  AGENT_BUS_V2_VERSION, BODY_KINDS, PROVIDERS, busBodySchema, busV2ContractSummary, claimKeysOverlap,
  claimSchema, findClaimConflict, globMatches, literalPrefix, mayMutateClaim, parseClaimKey,
  participantSchema, workJobSchema, type Claim,
} from '../src/core/agents/bus-v2-schema.js';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';

const TOKEN = 'a'.repeat(64);
const claim = (claimKey: string, leaseUntil = 2000, owner = 'dot-main'): Claim =>
  ({ claimKey, owner, leaseMs: 1000, token: TOKEN, leaseUntil });

describe('participants', () => {
  const ok = { participantId: 'dot-main', provider: 'openai-dot', displayName: 'Dot', capabilities: ['review'],
    wake: { kind: 'poll', target: 'dot-poll' }, status: 'active' };
  it('accepts every provider', () => {
    for (const provider of PROVIDERS) expect(participantSchema.safeParse({ ...ok, provider }).success).toBe(true);
  });
  it.each([
    ['unknown provider', { provider: 'gpt' }],
    ['url wake target', { wake: { kind: 'webhook', target: 'https://x.example/hook?t=1' } }],
    ['secret-shaped wake target', { wake: { kind: 'webhook', target: 'FAKETOKEN'.repeat(5) } }],
    ['bad wake kind', { wake: { kind: 'sms', target: 'x' } }],
    ['extra field', { secret: 'FAKE-TOKEN' }],
    ['bad status', { status: 'busy' }],
  ])('rejects %s', (_n, patch) => {
    expect(participantSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe('claim keys and overlap', () => {
  it('parses the four forms and rejects junk', () => {
    expect(parseClaimKey('repo:AshlrAI/Phantom')).toEqual({ kind: 'repo', repo: 'ashlrai/phantom' });
    expect(parseClaimKey('path:a/b:src/**')).toEqual({ kind: 'path', repo: 'a/b', glob: 'src/**' });
    expect(parseClaimKey('queue:q-1')).toEqual({ kind: 'queue', queue: 'q-1' });
    expect(parseClaimKey('pr:a/b#12')).toEqual({ kind: 'pr', repo: 'a/b', number: 12 });
    for (const bad of ['repo:nope', 'pr:a/b#0', 'pr:a/b#x', 'path:a/b:../x', 'path:a/b:/abs', 'queue:', 'x:y'])
      expect(parseClaimKey(bad), bad).toBeUndefined();
  });
  it('computes literal prefixes and globs', () => {
    expect(literalPrefix('src/core/*.ts')).toBe('src/core/');
    expect(literalPrefix('docs/a.md')).toBe('docs/a.md');
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatches('src/**', 'src/a/b.ts')).toBe(true);
  });
  it.each([
    ['repo:a/b', 'repo:A/B', true],
    ['repo:a/b', 'path:a/b:x/y.ts', true],
    ['path:a/b:x/y.ts', 'repo:a/b', true],
    ['repo:a/b', 'path:a/c:x', false],
    ['repo:a/b', 'pr:a/b#1', false],
    ['path:a/b:src/**', 'path:a/b:src/core/x.ts', true],
    ['path:a/b:src/core/x.ts', 'path:a/b:src/**', true],
    ['path:a/b:src/*.ts', 'path:a/b:src/core/**', false],
    ['path:a/b:docs/**', 'path:a/b:src/**', false],
    ['path:a/b:src/**', 'path:a/c:src/**', false],
    ['path:a/b:*.md', 'path:a/b:*.md', true],
    ['queue:q1', 'queue:q1', true],
    ['queue:q1', 'queue:q2', false],
    ['pr:a/b#1', 'pr:a/b#1', true],
    ['pr:a/b#1', 'pr:a/b#2', false],
    ['queue:q1', 'repo:a/b', false],
    ['bogus', 'repo:a/b', false],
  ])('%s vs %s -> %s (symmetric)', (a, b, want) => {
    expect(claimKeysOverlap(a, b)).toBe(want);
    expect(claimKeysOverlap(b, a)).toBe(want);
  });
});

describe('claims', () => {
  it('validates claim fields and lease bounds', () => {
    expect(claimSchema.safeParse(claim('repo:a/b')).success).toBe(true);
    expect(claimSchema.safeParse({ ...claim('repo:a/b'), leaseMs: 0 }).success).toBe(false);
    expect(claimSchema.safeParse({ ...claim('repo:a/b'), leaseMs: 3_600_001 }).success).toBe(false);
    expect(claimSchema.safeParse({ ...claim('repo:a/b'), leaseMs: 3_600_000 }).success).toBe(true);
    expect(claimSchema.safeParse({ ...claim('repo:a/b'), token: 'short' }).success).toBe(false);
    expect(claimSchema.safeParse(claim('nonsense')).success).toBe(false);
  });
  it('reports the live overlapping holder without a token, and frees expired claims', () => {
    const held = [claim('repo:a/b', 2000, 'holder')];
    const holder = findClaimConflict(held, 'path:a/b:src/**', 1999);
    expect(holder).toEqual({ owner: 'holder', claimKey: 'repo:a/b', leaseUntil: 2000 });
    expect(holder).not.toHaveProperty('token');
    expect(findClaimConflict(held, 'path:a/b:src/**', 2000)).toBeUndefined();
    expect(findClaimConflict(held, 'queue:q', 1)).toBeUndefined();
  });
  it('lets only the live token holder mutate', () => {
    const c = claim('repo:a/b');
    expect(mayMutateClaim(c, TOKEN, 1999)).toBe(true);
    expect(mayMutateClaim(c, 'b'.repeat(64), 1999)).toBe(false);
    expect(mayMutateClaim(c, 'short', 1999)).toBe(false);
    expect(mayMutateClaim(c, TOKEN, 2000)).toBe(false);
  });
});

describe('body kinds and work feed', () => {
  const valid: Record<string, unknown>[] = [
    { kind: 'note', text: 'hi', refs: ['pr:1'] },
    { kind: 'context', text: 'ctx', thread: 't1' },
    { kind: 'work.post', jobId: 'j1', title: 'Fix', repo: 'a/b', claimKeys: ['repo:a/b'] },
    { kind: 'work.claim', op: 'acquire', claimKey: 'queue:q', owner: 'dot-main', leaseMs: 1000 },
    { kind: 'work.claim', op: 'renew', claimKey: 'queue:q', token: TOKEN, leaseMs: 1000 },
    { kind: 'work.status', jobId: 'j1', status: 'rescheduled' },
    { kind: 'work.release', claimKey: 'queue:q', token: TOKEN, outcome: 'completed' },
    { kind: 'wake', target: 'dot-main', reason: 'new work' },
  ];
  it('covers every declared kind', () => {
    expect(new Set(valid.map((v) => v.kind))).toEqual(new Set(BODY_KINDS));
    for (const v of valid) expect(busBodySchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
  });
  it.each([
    { kind: 'note' },
    { kind: 'note', text: 'x', extra: 1 },
    { kind: 'work.status', jobId: 'j', status: 'paused' },
    { kind: 'work.claim', op: 'acquire', claimKey: 'queue:q', owner: 'o', leaseMs: 3_600_001 },
    { kind: 'work.claim', op: 'acquire', claimKey: 'queue:q', owner: 'o', leaseMs: 1, token: TOKEN },
    { kind: 'work.release', claimKey: 'queue:q', token: TOKEN, outcome: 'stolen' },
    { kind: 'work.post', jobId: 'j', title: 't', repo: 'nope', claimKeys: [] },
    { kind: 'unknown', text: 'x' },
  ])('rejects %j', (body) => {
    expect(busBodySchema.safeParse(body).success).toBe(false);
  });
  it('validates work jobs', () => {
    const job = { id: 'j1', owner: 'dot-main', provider: 'devin', repo: 'a/b', claimKeys: ['repo:a/b'],
      status: 'running', updatedAt: 5 };
    expect(workJobSchema.safeParse(job).success).toBe(true);
    expect(workJobSchema.safeParse({ ...job, status: 'paused' }).success).toBe(false);
    expect(workJobSchema.safeParse({ ...job, updatedAt: -1 }).success).toBe(false);
  });
});

describe('ashlr agents bus contract', () => {
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsCli(args, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('prints JSON with version and kinds', async () => {
    const r = await run(['bus', 'contract', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schemaVersion).toBe(AGENT_BUS_V2_VERSION);
    expect(j).toEqual(JSON.parse(JSON.stringify(busV2ContractSummary())));
    expect(j.bodyKinds).toEqual([...BODY_KINDS]);
  });
  it('prints plain text and help, and rejects bad usage', async () => {
    expect((await run(['bus', 'contract'])).out).toContain(AGENT_BUS_V2_VERSION);
    expect((await run([])).code).toBe(0);
    expect((await run(['bus', 'nope'])).code).toBe(2);
    expect((await run(['bus', 'contract', '--json', '--json'])).code).toBe(2);
    expect(JSON.parse((await run(['x', '--json'])).err)).toEqual({ error: 'invalid-argument' });
  });
});
