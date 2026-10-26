import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, handoffFleetClaim, postFleetMessage, proposeFleetAssignment, readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { cmdFleet } from '../src/cli/fleet.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-fleet-coordination-'));
  dirs.push(dir);
  return { path: join(dir, 'coordination.jsonl'), now: 1000 };
}
const WORK = { repo: 'ashlrai/phantom', task: 'Verify fleet snapshot', agent: 'codex-cmp', ttlMs: 1000 };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });

describe('host-only fleet coordination ledger', () => {
  it('refuses duplicate active work and appends releases without rewriting history', () => {
    const options = fixture();
    const result = claimFleetWork(WORK, options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('claim failed');
    const original = readFileSync(options.path, 'utf8');
    expect(claimFleetWork({ ...WORK, task: '  verify   FLEET snapshot ', agent: 'other' }, options)).toEqual({ ok: false, error: 'duplicate' });
    expect(releaseFleetClaim({ id: result.value.claim.id, agent: 'other', lease: result.value.lease }, options)).toEqual({ ok: false, error: 'not-owner' });
    expect(releaseFleetClaim({ id: result.value.claim.id, agent: WORK.agent, lease: 'bad' }, options)).toEqual({ ok: false, error: 'not-owner' });
    expect(releaseFleetClaim({ id: result.value.claim.id, agent: WORK.agent, lease: result.value.lease }, options).ok).toBe(true);
    expect(readFileSync(options.path, 'utf8').startsWith(original)).toBe(true);
    expect(readFleetBoard(options)).toMatchObject({ state: 'known', claims: [] });
    expect(claimFleetWork(WORK, options).ok).toBe(true);
  });
  it('filters expired claims on reads and reaps them under the write lock before replacement', () => {
    const options = fixture();
    const first = claimFleetWork(WORK, options);
    expect(first.ok).toBe(true);
    expect(readFleetBoard({ ...options, now: 2000 })).toMatchObject({ claims: [], expiredClaims: 1 });
    expect(claimFleetWork({ ...WORK, agent: 'successor' }, { ...options, now: 2000 }).ok).toBe(true);
    expect(readFileSync(options.path, 'utf8')).toContain('"kind":"reap"');
    expect(readFleetBoard({ ...options, now: 2000 })).toMatchObject({ claims: [{ agent: 'successor' }], expiredClaims: 0 });
    if (!first.ok) throw new Error('claim failed');
    expect(releaseFleetClaim({ id: first.value.claim.id, agent: WORK.agent, lease: first.value.lease }, { ...options, now: 2000 })).toEqual({ ok: false, error: 'not-found' });
  });
  it('rotates the lease on handoff and fences the old holder, including same-agent handoffs', () => {
    const options = fixture();
    const first = claimFleetWork(WORK, options);
    if (!first.ok) throw new Error('claim failed');
    const next = handoffFleetClaim({ id: first.value.claim.id, agent: WORK.agent, lease: first.value.lease, to: WORK.agent }, options);
    if (!next.ok) throw new Error('handoff failed');
    expect(next.value.lease).not.toBe(first.value.lease);
    expect(releaseFleetClaim({ id: first.value.claim.id, agent: WORK.agent, lease: first.value.lease }, options)).toEqual({ ok: false, error: 'not-owner' });
    expect(releaseFleetClaim({ id: first.value.claim.id, agent: WORK.agent, lease: next.value.lease }, options).ok).toBe(true);
    expect(JSON.stringify(readFleetBoard(options))).not.toContain('lease');
  });
  it('posts bounded TTL messages, refuses retries and only proposes assignments', () => {
    const options = fixture();
    const message = { from: 'codex', to: 'cursor', body: 'CI is ready', id: 'message-1', ttlMs: 1000 };
    expect(postFleetMessage(message, options).ok).toBe(true);
    expect(postFleetMessage(message, options)).toEqual({ ok: false, error: 'duplicate' });
    expect(postFleetMessage({ ...message, id: 'message-2' }, options)).toEqual({ ok: false, error: 'duplicate' });
    const proposal = proposeFleetAssignment({ repo: WORK.repo, task: WORK.task, to: 'cursor', ttlMs: 1000 }, options);
    expect(proposal).toMatchObject({ ok: true, value: { executionAuthorized: false } });
    expect(readFleetBoard(options)).toMatchObject({ claims: [], messages: [{ body: message.body }], proposals: [{ executionAuthorized: false }] });
    expect(readFleetBoard({ ...options, now: 2000 })).toMatchObject({ messages: [], proposals: [] });
    expect(proposeFleetAssignment({ repo: WORK.repo, task: WORK.task, to: 'cursor', ttlMs: 0 }, options)).toEqual({ ok: false, error: 'invalid-input' });
  });
  it('returns unknown and refuses changes for malformed, truncated, unsafe and symlinked ledgers', () => {
    const options = fixture();
    expect(readFleetBoard(options).state).toBe('unknown');
    for (const content of ['not-json\n', '{}\n', '{}']) {
      writeFileSync(options.path, content, { mode: 0o600 });
      expect(readFleetBoard(options).state).toBe('unknown');
      expect(claimFleetWork(WORK, options)).toEqual({ ok: false, error: 'unavailable' });
      expect(readFileSync(options.path, 'utf8')).toBe(content);
    }
    writeFileSync(options.path, '', { mode: 0o600 }); chmodSync(options.path, 0o644);
    expect(claimFleetWork(WORK, options)).toEqual({ ok: false, error: 'unavailable' });
    chmodSync(options.path, 0o600);
    const link = join(dirs.at(-1)!, 'link.jsonl'); symlinkSync(options.path, link);
    expect(readFleetBoard({ path: link }).state).toBe('unknown');
    expect(claimFleetWork(WORK, { path: link })).toEqual({ ok: false, error: 'unavailable' });
  });
  it('scrubs secret-bearing content and never publishes lease hashes', () => {
    const options = fixture();
    const token = 'ghp_' + 'a'.repeat(36);
    expect(claimFleetWork({ ...WORK, task: `Inspect ${token}` }, options).ok).toBe(true);
    expect(postFleetMessage({ from: 'codex', to: 'all', body: `token=${token}` }, options).ok).toBe(true);
    const encoded = JSON.stringify(readFleetBoard(options));
    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain('leaseHash');
  });
  it('serializes actual concurrent host processes so exactly one wins a duplicate race', async () => {
    const options = fixture();
    const moduleUrl = pathToFileURL(resolve('src/core/fleet/coordination.ts')).href;
    const script = `import { claimFleetWork } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(claimFleetWork(${JSON.stringify(WORK)}, ${JSON.stringify(options)})));`;
    const run = () => new Promise<{ ok: boolean; error?: string }>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', data => { out += String(data); }); child.stderr.on('data', data => { err += String(data); });
      child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(err)); else { try { accept(JSON.parse(out)); } catch (error) { reject(error); } } });
    });
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.error === 'duplicate')).toHaveLength(2);
    expect(readFleetBoard(options).claims).toHaveLength(1);
  });
});

describe('fleet coordination CLI', () => {
  it('rejects malformed arguments before creating state and help is inert', async () => {
    const options = fixture(); vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', options.path);
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--typo'], ['unexpected'], ['--agent'], ['--agent', 'a', '--agent', 'b'], ['--ttl-seconds', '1.5']]) expect(await cmdFleetCoordination('claim', args)).toBe(2);
    expect(await cmdFleetCoordination('claim', ['--help'])).toBe(0);
    expect(readFleetBoard(options).state).toBe('unknown');
  });
  it('offers claim, inbox and proposal-only assignment as structured JSON', async () => {
    const options = fixture(); vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', options.path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetCoordination('claim', ['--repo', WORK.repo, '--task', WORK.task, '--agent', WORK.agent, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: true, value: { claim: { task: WORK.task } } });
    expect(await cmdFleetCoordination('post', ['--from', WORK.agent, '--to', 'all', '--message', 'Ready', '--json'])).toBe(0);
    expect(await cmdFleetCoordination('inbox', ['--agent', 'cursor', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ messages: [{ body: 'Ready' }] });
    expect(await cmdFleetCoordination('assign', ['--repo', WORK.repo, '--task', 'Review', '--to', 'cursor', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: true, value: { executionAuthorized: false } });
  });
  it('dispatches through the fleet CLI and carries a fenced lease through handoff and release', async () => {
    const options = fixture(); vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', options.path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const invoke = async (args: string[]) => { const code = await cmdFleet(args); return { code, result: JSON.parse(log.mock.calls.at(-1)![0]) }; };
    const claimed = await invoke(['claim', '--repo', WORK.repo, '--task', WORK.task, '--agent', 'codex', '--json']);
    expect(claimed.code).toBe(0);
    const id = claimed.result.value.claim.id;
    const transferred = await invoke(['handoff', id, '--agent', 'codex', '--lease', claimed.result.value.lease, '--to', 'cursor', '--json']);
    expect(transferred).toMatchObject({ code: 0, result: { value: { claim: { agent: 'cursor' } } } });
    expect((await invoke(['release', id, '--agent', 'codex', '--lease', claimed.result.value.lease, '--json'])).code).toBe(1);
    expect((await invoke(['release', id, '--agent', 'cursor', '--lease', transferred.result.value.lease, '--json'])).code).toBe(0);
    expect((await invoke(['board', '--json'])).result).toMatchObject({ state: 'known', claims: [] });
  });

});
