import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { spawnAgent, type SpawnInput } from './agents-queries.js';
const input: SpawnInput = { root: '/repo', seatId: 'claude', model: 'model', title: 'Task', prompt: 'Do task',
  isolate: true, planFirst: false, spendCapUsd: null, autoFix: false, autoMerge: false };
const made = { agent: { id: 'agent', workspace: { path: '/workspace' } }, config: {}, archivedForCap: [] };
beforeEach(() => setMutationToken(TEST_TOKEN));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('never discards a workspace after an unknown session creation outcome', async () => {
  const { calls } = installFetch(call => {
    if (call.path.endsWith('/workspaces')) return json(made, 201);
    if (call.path === '/api/verse/sessions') throw new TypeError('Lost response');
    return json({ ok: true });
  });
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', stage: 'session', agentId: 'agent' });
  expect(calls.some(call => call.path.endsWith('/discard'))).toBe(false);
});
it('preserves known chat and workspace after an effectful bind fails', async () => {
  installFetch(call => call.path.endsWith('/workspaces') ? json(made, 201)
    : call.path === '/api/verse/sessions' ? json({ id: 'chat' }, 201) : json({ error: 'failed after starting' }, 500));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', stage: 'bind', agentId: 'agent', sessionId: 'chat' });
});
it('only retries a refused session creation after confirmed workspace cleanup', async () => {
  const { calls } = installFetch(call => call.path.endsWith('/workspaces') ? json(made, 201)
    : call.path === '/api/verse/sessions' ? json({ code: 'VERSE_INVALID', error: 'Unknown seat' }, 400) : json({ ok: true }));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'failed', stage: 'session' });
  expect(calls.filter(call => call.path.endsWith('/discard'))).toHaveLength(1);
});
it('marks cleanup failure uncertain even when the chat creation was refused', async () => {
  installFetch(call => call.path.endsWith('/workspaces') ? json(made, 201)
    : call.path === '/api/verse/sessions' ? json({ code: 'VERSE_INVALID', error: 'Unknown seat' }, 400) : json({ error: 'cleanup failed' }, 500));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', agentId: 'agent' });
});
it.each([500, 503, 409])('does not infer an unstarted launch from generic HTTP %s', async status => {
  installFetch(() => json({ error: 'failure' }, status));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', stage: 'workspace' });
});
it('identifies an initial mutation-token refusal as safely unstarted', async () => {
  installFetch(() => json({ error: 'refused' }, 401));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'failed', stage: 'workspace' });
});


it('treats malformed success responses as uncertain without issuing dependent writes', async () => {
  const { calls } = installFetch(() => json({ unexpected: true }, 201));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', stage: 'workspace' });
  expect(calls).toHaveLength(1);
});
it('never replays a plain-chat launch after adoption fails', async () => {
  installFetch(call => call.path === '/api/verse/sessions' ? json({ id: 'chat' }, 201) : json({ error: 'refused' }, 401));
  await expect(spawnAgent({ ...input, isolate: false })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'adopt', sessionId: 'chat' });
});


it('does not trust a precreation code attached to an unexpected HTTP failure status', async () => {
  const { calls } = installFetch(call => call.path.endsWith('/workspaces') ? json(made, 201)
    : json({ code: 'VERSE_INVALID', error: 'unexpected internal failure' }, 500));
  await expect(spawnAgent(input)).rejects.toMatchObject({ outcome: 'uncertain', stage: 'session', agentId: 'agent' });
  expect(calls.some(call => call.path.endsWith('/discard'))).toBe(false);
});
