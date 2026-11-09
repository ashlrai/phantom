/**
 * Forum foundation: payload validation, HMAC identity, key sources, the
 * atomic store, and wake limits. No service, CLI or HTTP surface is involved.
 */
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalPost, checkBody, isAgentId, parseMentions, parsePayload, signPost, stableJson, verifyPost,
} from '../src/core/fleet/forum/canon.js';
import { parseEnvKeys, readKeyFile, resolveAgentKey } from '../src/core/fleet/forum/keys.js';
import { planWakes, prune } from '../src/core/fleet/forum/policy.js';
import { emptyState, readState, withForumLock, writeState } from '../src/core/fleet/forum/store.js';
import { FORUM_POSTS_PER_WINDOW, FORUM_STEWARD, FORUM_WINDOW_MS } from '../src/core/fleet/forum/types.js';

// Keys are built at runtime so no literal here resembles key material.
const KEY = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const NOW = Date.parse('2026-11-02T00:00:00.000Z');
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fleet-forum-core-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('canon', () => {
  it('signs the claimed post and rejects a changed body, key or malformed signature', () => {
    const base = { authorId: 'codex', channelId: 'goals', threadId: '-', parentId: '-', kind: 'note', clientId: '-', payload: {} };
    const sig = signPost(KEY, canonicalPost({ ...base, body: 'hello' }));
    expect(verifyPost(KEY, canonicalPost({ ...base, body: 'hello' }), sig)).toBe(true);
    expect(verifyPost(KEY, canonicalPost({ ...base, body: 'hello!' }), sig)).toBe(false);
    expect(verifyPost(OTHER, canonicalPost({ ...base, body: 'hello' }), sig)).toBe(false);
    expect(verifyPost(KEY, canonicalPost({ ...base, body: 'hello' }), 'zz')).toBe(false);
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
  });

  it('keeps the steward reserved and extracts distinct mentions', () => {
    expect(isAgentId('codex-local')).toBe(true);
    expect(isAgentId(FORUM_STEWARD)).toBe(false);
    expect(isAgentId('Codex')).toBe(false);
    expect(parseMentions('@codex ping @claude and @codex again')).toEqual(['codex', 'claude']);
  });

  it('stores shell-shaped text, refuses secret-shaped text, and drops unknown payload fields', () => {
    expect(checkBody('run `rm -rf /` $(id)')).toEqual({ ok: true, body: 'run `rm -rf /` $(id)' });
    const secret = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    expect(checkBody(`token ${secret}`)).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(checkBody('bad \u0000 byte')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePayload('note', { extra: 1 })).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePayload('commitment', { owner: 'codex', summary: 's', deadline: 'never' })).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePayload('commitment', { owner: 'codex', summary: 's', deadline: '2026-11-03T00:00:00Z', jobId: 'job-1' }))
      .toMatchObject({ ok: true, payload: { kind: 'commitment', status: 'open', jobId: 'job-1' } });
  });
});

describe('keys', () => {
  it('reads env keys, ignores malformed entries, and prefers env over a private key file', async () => {
    expect([...parseEnvKeys(`codex:${KEY},bad:short,:${KEY},${FORUM_STEWARD}:${KEY}`).keys()]).toEqual(['codex']);
    const file = join(root, 'keys.json');
    await writeFile(file, JSON.stringify({ agents: { codex: OTHER, claude: KEY } }), { mode: 0o600 });
    expect(await resolveAgentKey('codex', { PHANTOM_FORUM_AGENT_KEYS: `codex:${KEY}`, PHANTOM_FORUM_KEY_FILE: file })).toBe(KEY);
    expect(await resolveAgentKey('claude', { PHANTOM_FORUM_KEY_FILE: file })).toBe(KEY);
    expect(await resolveAgentKey('nobody', { PHANTOM_FORUM_KEY_FILE: file })).toBeNull();
  });

  it('refuses a key file that is group readable or not absolute', async () => {
    const file = join(root, 'open.json');
    await writeFile(file, JSON.stringify({ agents: { codex: KEY } }));
    await chmod(file, 0o640);
    if (process.platform !== 'win32') expect((await readKeyFile(file)).size).toBe(0);
    expect((await readKeyFile('keys.json')).size).toBe(0);
  });
});

describe('store and policy', () => {
  it('round-trips atomically, reports a missing file as empty, and fails closed on a bad document', async () => {
    const first = await readState(root, '2026-11-02T00:00:00.000Z');
    expect(first).toMatchObject({ ok: true, stored: false });
    const state = emptyState('2026-11-02T00:00:00.000Z');
    expect(await writeState(root, state)).toEqual({ ok: true });
    expect(await readState(root, '')).toMatchObject({ ok: true, stored: true, state: { v: 1 } });
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await writeFile(join(root, 'forum.json'), '{"v":2}');
    expect(await readState(root, '')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('serializes lock holders even when an earlier one throws', async () => {
    const order: number[] = [];
    const a = withForumLock(root, async () => { await new Promise((r) => setTimeout(r, 10)); order.push(1); throw new Error('x'); });
    const b = withForumLock(root, async () => { order.push(2); });
    await expect(a).rejects.toThrow('x');
    await b;
    expect(order).toEqual([1, 2]);
  });

  it('limits post floods, suppresses a mention loop and self wakes, and prunes old rows', () => {
    const state = emptyState('2026-11-02T00:00:00.000Z');
    state.postTimes = Array.from({ length: FORUM_POSTS_PER_WINDOW }, () => ({ author: 'codex', at: NOW - 1000 }));
    expect(planWakes(state, 'codex', [], NOW, false)).toEqual({ ok: false, reason: 'rate-limited' });
    expect(planWakes(state, 'codex', [], NOW, true)).toEqual({ ok: true, plans: [] });
    state.postTimes = [];
    state.wakes = [
      { from: 'codex', to: 'claude', at: NOW - 1000, status: 'sent' }, { from: 'codex', to: 'claude', at: NOW - 900, status: 'sent' },
      { from: 'claude', to: 'codex', at: NOW - 800, status: 'sent' }, { from: 'claude', to: 'codex', at: NOW - 700, status: 'sent' },
    ];
    expect(planWakes(state, 'codex', ['claude', 'codex', 'devin'], NOW, false)).toEqual({
      ok: true,
      plans: [
        { target: 'claude', status: 'suppressed-loop' },
        { target: 'codex', status: 'suppressed-self' },
        { target: 'devin', status: 'sent' },
      ],
    });
    state.wakes.push({ from: 'a', to: 'b', at: NOW - FORUM_WINDOW_MS - 1, status: 'sent' });
    prune(state, NOW);
    expect(state.wakes).toHaveLength(4);
  });
});
