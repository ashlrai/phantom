import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearHandlers, emit, registerBuiltInHandlers } from '../src/core/fleet/event-bus.js';

const mocks = vi.hoisted(() => ({
  configured: vi.fn(), enqueue: vi.fn(), load: vi.fn(), identity: vi.fn(), notify: vi.fn(),
}));

vi.mock('../src/core/fleet/router-queue.js', () => ({
  routerQueueConfigured: mocks.configured,
  enqueueRouterFollowup: mocks.enqueue,
}));
vi.mock('../src/core/inbox/store.js', () => ({ loadProposal: mocks.load }));
vi.mock('../src/core/inbox/realized-merge.js', () => ({ canonicalRealizedMergeIdentity: mocks.identity }));
vi.mock('../src/core/comms/events.js', () => ({ notifyFleetEvent: mocks.notify }));

const prUrl = 'https://github.com/ashlrai/phantom/pull/42';
const headSha = 'a'.repeat(40);
const mergeSha = 'b'.repeat(40);
const mergedAt = '2026-10-26T00:00:00.000Z';
const cfg = { foundry: {} } as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.load.mockReturnValue({ id: 'prop-42', realizedMerge: {
    source: 'github-host', expectedHeadOid: headSha, mergedAt,
  } });
  mocks.identity.mockReturnValue({ source: 'github-host', prUrl, mergeCommitOid: mergeSha });
  _clearHandlers();
  registerBuiltInHandlers();
});

describe('router queue merge lifecycle integration', () => {
  it('does not read proposals or create jobs without queue configuration', async () => {
    mocks.configured.mockReturnValue(false);
    await emit('merge:shipped', { proposalId: 'prop-42' }, cfg);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '../escape', '.', '..', 'prop\n42', '$(touch /tmp/owned)'])(
    'does not load a spoofed proposal identifier %j', async proposalId => {
      await emit('merge:shipped', { proposalId, repo: 'ashlrai/phantom', title: prUrl }, cfg);
      expect(mocks.load).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });

  it('requires a stored proposal', async () => {
    mocks.load.mockReturnValue(null);
    await emit('merge:shipped', { proposalId: 'prop-42' }, cfg);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([null, { source: 'local-default-branch', mergeCommitOid: mergeSha }])(
    'rejects missing or non-GitHub authenticated evidence %j', async identity => {
      mocks.identity.mockReturnValue(identity);
      await emit('merge:shipped', { proposalId: 'prop-42' }, cfg);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });

  it('requires GitHub evidence in the sanitized stored proposal', async () => {
    mocks.load.mockReturnValue({ id: 'prop-42', realizedMerge: { source: 'local-default-branch' } });
    await emit('merge:shipped', { proposalId: 'prop-42' }, cfg);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('uses authenticated PR identity and stored merge metadata, ignoring event text', async () => {
    await emit('merge:shipped', { proposalId: 'prop-42', repo: 'attacker/repo', title: '$(evil)' }, cfg);
    expect(mocks.load).toHaveBeenCalledWith('prop-42');
    expect(mocks.identity).toHaveBeenCalledWith(mocks.load.mock.results[0]!.value);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ v: 1, state: 'MERGED', prUrl, headSha, mergeSha, mergedAt });
  });

  it('keeps queue failure best effort and still notifies operators', async () => {
    mocks.enqueue.mockImplementation(() => { throw new Error('Queue rejected'); });
    await expect(emit('merge:shipped', { proposalId: 'prop-42' }, cfg)).resolves.toBeUndefined();
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('queues follow-up work even when operator notification fails', async () => {
    mocks.notify.mockRejectedValue(new Error('Notification failed'));
    await emit('merge:shipped', { proposalId: 'prop-42' }, cfg);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('fails closed when proposal loading throws', async () => {
    mocks.load.mockImplementation(() => { throw new Error('Unreadable inbox'); });
    await expect(emit('merge:shipped', { proposalId: 'prop-42' }, cfg)).resolves.toBeUndefined();
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('preserves the event bus disable gate', async () => {
    await emit('merge:shipped', { proposalId: 'prop-42' }, { foundry: { eventBus: false } } as never);
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
