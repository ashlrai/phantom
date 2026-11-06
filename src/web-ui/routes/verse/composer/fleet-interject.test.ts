import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { FleetInboxUnavailableError, postFleetInterjection } from './fleet-interject.js';

vi.mock('../../../data/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(), apiPost: vi.fn(),
}));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn(), touchMutationHold: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMutationToken).mockReturnValue('fixture-mutation-token');
});
describe('postFleetInterjection', () => {
  it('returns the acknowledgement and sends the desktop chat source', async () => {
    const ack = { at: '2026-10-31 00:13' };
    vi.mocked(apiPost).mockResolvedValue(ack);
    await expect(postFleetInterjection('hello')).resolves.toEqual(ack);
    expect(apiPost).toHaveBeenCalledWith('/api/verse/fleet/runs/inbox', { text: 'hello', source: 'Phantom desktop chat' }, 'fixture-mutation-token');
    expect(touchMutationHold).toHaveBeenCalledOnce();
  });
  it('maps 404 to an unavailable error', async () => {
    vi.mocked(apiPost).mockRejectedValue(new ApiError('missing', 404, '/api/verse/fleet/runs/inbox'));
    await expect(postFleetInterjection('hello')).rejects.toBeInstanceOf(FleetInboxUnavailableError);
  });
  it.each([401, 403])('maps %s to mutation hold guidance', async status => {
    vi.mocked(apiPost).mockRejectedValue(new ApiError('locked', status, '/api/verse/fleet/runs/inbox'));
    await expect(postFleetInterjection('hello')).rejects.toThrow('Unlock actions with the mutation token before chatting.');
  });
  it('requires an unlocked mutation hold', async () => {
    vi.mocked(getMutationToken).mockReturnValue(null);
    await expect(postFleetInterjection('hello')).rejects.toThrow('Unlock actions');
    expect(apiPost).not.toHaveBeenCalled();
  });
  it('rejects an unconfirmed response', async () => {
    vi.mocked(apiPost).mockResolvedValue({});
    await expect(postFleetInterjection('hello')).rejects.toThrow('could not be confirmed');
    expect(touchMutationHold).not.toHaveBeenCalled();
  });
});
