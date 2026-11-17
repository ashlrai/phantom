import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDevinAutoland, setDevinAutolandPaused, type DevinAutolandDeps } from '../src/core/devin/autoland.js';
import { ensureDevinAutolandTimer, stopDevinAutolandTimer } from '../src/core/devin/autoland-timer.js';
import { DevinClient, parseDevinSession, type DevinSession, type DevinSelf, type DevinFetch } from '../src/core/devin/client.js';
import type { CommandRunner } from '../src/core/devin/land.js';

const id = 'devin-0123456789abcdef0123456789abcdef';
let home: string;
let dir: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'autoland-')); dir = join(home, '.ashlr', 'devin'); vi.stubEnv('ASHLR_HOME', join(home, '.ashlr')); });
afterEach(() => { stopDevinAutolandTimer(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const session = (patch: Partial<DevinSession> = {}): DevinSession => ({ sessionId: id, serviceUserId: 'ours', url: 'https://app.devin.ai/sessions/x', status: 'suspended', statusDetail: null, acusConsumed: 1, pullRequests: [], tags: [], title: null, structuredOutput: null, ...patch });
const self: DevinSelf = { principal: 'service_user', orgId: 'org-test', name: null, identity: { principal: 'service_user', serviceUserId: 'ours', userId: null, apiKeyId: null, orgId: null, devinSessionsOrgId: null } };
function world(sessions = [session()]) {
  const attachments = [{ attachmentId: 'b1', name: 'x.bundle', url: 'https://app.devin.ai/a', source: 'devin' as const, contentType: null }, { attachmentId: 'p1', name: 'x.pr.md', url: 'https://app.devin.ai/p', source: 'devin' as const, contentType: null }];
  const client = { getSelf: vi.fn(async () => self), listSessions: vi.fn(async () => ({ items: sessions, hasNextPage: false, endCursor: null })), listSessionAttachments: vi.fn(async () => attachments), terminateSession: vi.fn(async () => null), archiveSession: vi.fn(async () => session()) };
  const land = vi.fn(async () => ({ v: 1 as const, ok: true, mode: 'apply' as const, sessionId: id, repo: 'phantom', job: 'J', steps: [], commitCount: 2, publish: { pr: 'https://github.com/ashlrai/phantom/pull/2', result: 'PR', sens: '', headSha: null } }));
  const run = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '', stderr: '' }));
  const deps: DevinAutolandDeps = { home, api: async () => ({ client, orgId: 'org-test' }), land, run, killActive: () => false, now: () => new Date('2026-11-17T12:00:00Z') };
  return { deps, client, land, run, attachments };
}
const codes = (result: Awaited<ReturnType<typeof runDevinAutoland>>) => result.decisions.map(row => row.decision);
function save(file: string, rows: unknown[]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }

it('returns an empty pass without writes and admits PAT ownership by user ID', async () => {
  const w = world([]);
  expect(await runDevinAutoland({ apply: false }, w.deps)).toMatchObject({ ok: true, decisions: [], landed: 0 });
  expect(existsSync(dir)).toBe(false);
  const pat = world([session({ serviceUserId: undefined, userId: 'pat' })]);
  expect(codes(await runDevinAutoland({ apply: false }, { ...pat.deps, getSelf: async () => ({ ...self, principal: 'pat_user', identity: { ...self.identity!, principal: 'pat_user', serviceUserId: null, userId: 'pat' } }) }))).toEqual(['would-land', 'would-archive']);
});
it('filters foreign, archived, working and missing attachments', async () => {
  const w = world([session({ serviceUserId: 'other' }), session({ sessionId: 'devin-' + '1'.repeat(32), isArchived: true }), session({ sessionId: 'devin-' + '2'.repeat(32), status: 'error' }), session({ sessionId: 'devin-' + '3'.repeat(32) })]);
  w.attachments.length = 0;
  const result = await runDevinAutoland({ apply: true }, w.deps);
  expect(codes(result)).toEqual(['missing-attachments', 'scanned']);
  expect(result.decisions.at(-1)).toMatchObject({ counts: { 'not-ours': 1, 'already-archived': 1, 'not-finished': 1 } });
  expect(readFileSync(join(dir, 'autoland.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  expect(w.land).not.toHaveBeenCalled();
});
it('dry run computes a landing but writes nothing and does not clean up', async () => {
  const w = world();
  const result = await runDevinAutoland({ apply: false }, w.deps);
  expect(codes(result)).toEqual(['would-land', 'would-archive']);
  expect(result.decisions[0]?.commitCount).toBe(2);
  expect(w.land).toHaveBeenCalledWith(expect.objectContaining({ apply: false, bundle: 'x.bundle' }));
  expect(w.client.terminateSession).not.toHaveBeenCalled();
  expect(existsSync(dir)).toBe(false);
});
it('apply lands, terminates, archives and journals', async () => {
  const w = world();
  expect(await runDevinAutoland({ apply: true }, w.deps)).toMatchObject({ ok: true, landed: 1 });
  expect(w.client.terminateSession).toHaveBeenCalledWith('org-test', id);
  expect(w.client.archiveSession).toHaveBeenCalledWith('org-test', id);
  expect(readFileSync(join(dir, 'autoland.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).decision)).toEqual(['landed', 'archived']);
});
it('retries failed cleanup after a published landing without landing again', async () => {
  const w = world();
  const pr = 'https://github.com/ashlrai/phantom/pull/2';
  w.land.mockImplementationOnce(async () => {
    save('landings.jsonl', [{ sessionId: id, pr }]);
    return { v: 1, ok: true, mode: 'apply', sessionId: id, repo: 'phantom', job: 'J', steps: [], commitCount: 2,
      publish: { pr, result: 'PR', sens: '', headSha: null } };
  });
  w.client.archiveSession.mockRejectedValueOnce(new Error('Archive denied'));

  const first = await runDevinAutoland({ apply: true }, w.deps);
  expect(codes(first)).toEqual(['landed', 'archive-failed']);
  expect(w.land).toHaveBeenCalledOnce();

  const retried = await runDevinAutoland({ apply: true }, w.deps);
  expect(codes(retried)).toEqual(['already-landed', 'archived']);
  expect(w.land).toHaveBeenCalledOnce();
  expect(w.client.terminateSession).toHaveBeenCalledTimes(2);
  expect(w.client.archiveSession).toHaveBeenCalledTimes(2);
});
it('manual or matching prior landing only retries cleanup; later bundles supersede', async () => {
  const w = world([session({ isArchived: true })]); const pr = 'https://github.com/ashlrai/phantom/pull/1';
  save('landings.jsonl', [{ sessionId: id, pr }]);
  expect(codes(await runDevinAutoland({ apply: true }, w.deps))).toEqual(['already-landed', 'archived']);
  save('autoland.jsonl', [{ sessionId: id, pr, decision: 'landed', bundleAttachmentId: 'b1' }]);
  expect(codes(await runDevinAutoland({ apply: false }, w.deps))).toEqual(['already-landed', 'would-archive']);
  w.attachments[0]!.attachmentId = 'b2';
  expect(codes(await runDevinAutoland({ apply: true }, w.deps))).toEqual(['landed', 'superseded', 'archived']);
  expect(w.land).toHaveBeenCalledWith(expect.objectContaining({ job: 'DEVIN-0123456789ab-r2' }));
  expect(w.run.mock.calls[0]).toEqual(['gh', ['pr', 'close', pr, '--repo', 'ashlrai/phantom', '--comment', `Superseded by https://github.com/ashlrai/phantom/pull/2 (later bundle from Devin session ${id}).`], expect.any(Object)]);
  w.run.mockRejectedValueOnce(new Error('Close denied\nTry again'));
  w.client.archiveSession.mockClear();
  const closeFailure = await runDevinAutoland({ apply: true }, w.deps);
  expect(closeFailure.decisions.find(row => row.decision === 'pending-supersede')?.error).toBe('Close denied Try again');
  expect(w.client.archiveSession).not.toHaveBeenCalled();
  save('landings.jsonl', [{ sessionId: id, pr }, { sessionId: id, pr: 'https://github.com/ashlrai/phantom/pull/2' }]);
  const retried = await runDevinAutoland({ apply: true }, { ...w.deps, now: () => new Date('2026-11-17T12:15:00Z') });
  expect(codes(retried)).toEqual(['superseded', 'archived']);
  expect(w.run).toHaveBeenCalledTimes(3);
  expect(w.client.archiveSession).toHaveBeenCalledOnce();
});
it('settles an old close before landing a newer bundle without archiving early', async () => {
  const w = world();
  const firstPr = 'https://github.com/ashlrai/phantom/pull/1';
  const secondPr = 'https://github.com/ashlrai/phantom/pull/2';
  const thirdPr = 'https://github.com/ashlrai/phantom/pull/3';
  w.attachments[0]!.attachmentId = 'b2';
  w.attachments[0]!.url = 'https://app.devin.ai/b2';
  save('landings.jsonl', [{ sessionId: id, pr: firstPr }, { sessionId: id, pr: secondPr }]);
  save('autoland.jsonl', [
    { sessionId: id, pr: firstPr, decision: 'landed', bundleAttachmentId: 'b0' },
    { sessionId: id, pr: secondPr, decision: 'landed', bundleAttachmentId: 'b1' },
    { sessionId: id, pr: secondPr, supersededPr: firstPr, repo: 'phantom', decision: 'pending-supersede', bundleAttachmentId: 'b1', at: '2026-11-17T12:00:00Z' },
  ]);
  const order: string[] = [];
  w.run.mockImplementation(async (_cmd, args) => { order.push(`close:${String(args[2])}`); return { code: 0, stdout: '', stderr: '' }; });
  w.land.mockImplementationOnce(async () => {
    order.push('land');
    return { v: 1, ok: true, mode: 'apply', sessionId: id, repo: 'phantom', job: 'J', steps: [], commitCount: 2, publish: { pr: thirdPr, result: 'PR', sens: '', headSha: null } };
  });
  w.client.archiveSession.mockImplementation(async () => { order.push('archive'); return session({ status: 'exit', isArchived: true }); });
  const result = await runDevinAutoland({ apply: true }, { ...w.deps, now: () => new Date('2026-11-17T12:15:00Z') });
  expect(codes(result)).toEqual(['superseded', 'landed', 'superseded', 'archived']);
  expect(w.land).toHaveBeenCalledWith(expect.objectContaining({ bundle: 'x.bundle', job: 'DEVIN-0123456789ab-r3' }));
  expect(order).toEqual([`close:${firstPr}`, 'land', `close:${secondPr}`, 'archive']);
});
it('archives after closing a legacy superseded landing without re-landing it', async () => {
  const w = world();
  const firstPr = 'https://github.com/ashlrai/phantom/pull/1';
  const secondPr = 'https://github.com/ashlrai/phantom/pull/2';
  save('landings.jsonl', [{ sessionId: id, pr: firstPr }, { sessionId: id, pr: secondPr }]);
  save('autoland.jsonl', [
    { sessionId: id, pr: secondPr, decision: 'landed' },
    { sessionId: id, pr: secondPr, supersededPr: firstPr, repo: 'phantom', decision: 'pending-supersede', at: '2026-11-17T12:00:00Z' },
  ]);
  const result = await runDevinAutoland({ apply: true }, { ...w.deps, now: () => new Date('2026-11-17T12:15:00Z') });
  expect(codes(result)).toEqual(['superseded', 'archived']);
  expect(w.land).not.toHaveBeenCalled();
  expect(w.run).toHaveBeenCalledOnce();
  expect(w.client.archiveSession).toHaveBeenCalledOnce();
});
it('only counts an already terminated and archived landing in the scan', async () => {
  const w = world([session({ isArchived: true, status: 'exit' })]);
  save('landings.jsonl', [{ sessionId: id, pr: 'https://github.com/ashlrai/phantom/pull/1' }]);
  expect(codes(await runDevinAutoland({ apply: true }, w.deps))).toEqual(['scanned']);
  expect(w.client.listSessionAttachments).not.toHaveBeenCalled();
  expect(w.land).not.toHaveBeenCalled();
});
it('uses fresh retry job IDs, including after a superseding revision suffix', async () => {
  const w = world();
  const fail = { sessionId: id, decision: 'land-failed', bundleAttachmentId: 'b1', at: '2026-11-17T10:00:00Z' };
  save('autoland.jsonl', [fail]);
  await runDevinAutoland({ apply: true }, w.deps);
  expect(w.land).toHaveBeenLastCalledWith(expect.objectContaining({ job: 'DEVIN-0123456789ab-a2' }));
  const pr = 'https://github.com/ashlrai/phantom/pull/1';
  save('landings.jsonl', [{ sessionId: id, pr }]);
  save('autoland.jsonl', [{ sessionId: id, pr, decision: 'landed', bundleAttachmentId: 'b0' }, fail]);
  await runDevinAutoland({ apply: true }, w.deps);
  expect(w.land).toHaveBeenLastCalledWith(expect.objectContaining({ job: 'DEVIN-0123456789ab-r2-a2' }));
});
it('caps attempts, backs off and gives up until a new bundle', async () => {
  const w = world([session(), session({ sessionId: 'devin-' + '1'.repeat(32) })]);
  expect(codes(await runDevinAutoland({ apply: false, cap: 1 }, w.deps))).toContain('cap-reached');
  const fail = { sessionId: id, decision: 'land-failed', bundleAttachmentId: 'b1', at: '2026-11-17T11:59:00Z' };
  save('autoland.jsonl', [fail]);
  expect(codes(await runDevinAutoland({ apply: false }, w.deps))[0]).toBe('backoff');
  save('autoland.jsonl', Array(5).fill(fail));
  expect(codes(await runDevinAutoland({ apply: false }, w.deps))[0]).toBe('gave-up');
  w.attachments[0]!.attachmentId = 'b2';
  expect(codes(await runDevinAutoland({ apply: false }, w.deps))[0]).toBe('would-land');
});
it('honors KILL, pause and refuses missing identity', async () => {
  const w = world();
  expect(codes(await runDevinAutoland({ apply: false }, { ...w.deps, killActive: () => true }))).toEqual(['killed']);
  setDevinAutolandPaused(true);
  expect(codes(await runDevinAutoland({ apply: false }, w.deps))).toEqual(['paused']);
  setDevinAutolandPaused(false);
  expect(codes(await runDevinAutoland({ apply: false }, { ...w.deps, getSelf: async () => ({ principal: 'other', orgId: null, name: null }) }))).toEqual(['no-identity']);
});
it('retains bounded one-line failure diagnostics and scrubs credentials', async () => {
  const w = world();
  const key = 'cog_' + 'testcredential'.repeat(4);
  w.land.mockRejectedValueOnce(new Error(`Landing failed\n${key}`));
  const failure = await runDevinAutoland({ apply: true }, w.deps);
  expect(codes(failure)).toEqual(['land-failed']);
  expect(failure.decisions[0]?.error).toContain('Landing failed ');
  expect(JSON.stringify(failure)).not.toContain(key);
  w.client.archiveSession.mockRejectedValueOnce(new Error('Archive denied\nTry later'));
  expect(codes(await runDevinAutoland({ apply: false }, { ...w.deps, now: () => new Date('2026-11-18') }))).toContain('would-land');
  const result = await runDevinAutoland({ apply: true }, { ...w.deps, now: () => new Date('2026-11-18') });
  expect(codes(result)).toContain('archive-failed');
  expect(result.decisions.at(-1)?.error).toBe('Archive denied Try later');
  w.client.listSessionAttachments.mockRejectedValueOnce(new Error('Attachment denied'));
  expect((await runDevinAutoland({ apply: false }, w.deps)).decisions[0]?.error).toBe('Attachment denied');
  const failed = { ...await w.land(), ok: false, error: 'Bundle invalid\n' + 'x'.repeat(400) };
  w.land.mockResolvedValueOnce(failed);
  const invalid = await runDevinAutoland({ apply: false }, { ...w.deps, now: () => new Date('2026-11-18') });
  expect(invalid.decisions[0]?.error).toBe(('Bundle invalid ' + 'x'.repeat(400)).slice(0, 300));
  expect((await runDevinAutoland({ apply: false }, { ...w.deps, api: async () => { throw new Error('Connection failed\nTry again'); } })).decisions[0]?.error).toBe('Connection failed Try again');
});
it('archives with the v3 create-policy endpoint and parses ownership fields', async () => {
  const raw = { session_id: id, url: 'https://app.devin.ai/sessions/x', status: 'exit', service_user_id: 'ours', is_archived: true };
  const fetch = vi.fn<DevinFetch>(async () => new Response(JSON.stringify(raw), { status: 200 }));
  const client = new DevinClient({ apiKey: 'test-key', fetch });
  expect(await client.archiveSession('org-test', id)).toMatchObject({ serviceUserId: 'ours', isArchived: true });
  expect(fetch.mock.calls[0]).toEqual([`https://api.devin.ai/v3/organizations/org-test/sessions/${id}/archive`, expect.objectContaining({ method: 'POST' })]);
  expect(parseDevinSession({ ...raw, service_user_id: '../bad' })).toBeNull();
  expect(parseDevinSession({ ...raw, is_archived: 'yes' })).toBeNull();
});
it('resident timer is single-flight, observes a deadline and stops', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pass = vi.fn<(signal: AbortSignal) => Promise<void>>(() => new Promise<void>(resolve => { finish = resolve; }));
  const ready = vi.fn(async () => true);
  ensureDevinAutolandTimer({ ready, pass, firstMs: 10, intervalMs: 10, deadlineMs: 15 });
  ensureDevinAutolandTimer({ ready, pass, firstMs: 1 });
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledTimes(1);
  expect(pass.mock.calls[0]?.[0].aborted).toBe(true);
  stopDevinAutolandTimer(); finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledTimes(1);
});
