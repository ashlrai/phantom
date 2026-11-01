import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import * as client from '../../../data/client.js';
import { matchSlashCommands, parseBusCommand } from './composer-text.js';
import { buildMasonEnvelope, runBusCommand } from './bus-post-command.js';

afterEach(() => { clearMutationToken(); vi.restoreAllMocks(); });
beforeEach(() => setMutationToken('fixture-token'));

describe('bus command parsing', () => {
  it('offers the command and leaves other commands alone', () => {
    expect(matchSlashCommands('bus').map(command => command.id)).toContain('bus');
    expect(parseBusCommand('/business leaders hello')).toBeNull();
    expect(parseBusCommand('hello /bus leaders hello')).toBeNull();
  });
  it('parses recipient and multiline text', () => {
    expect(parseBusCommand('/bus job-123  ship now\nplease ')).toEqual({ to: 'job-123', text: 'ship now\nplease' });
    expect(parseBusCommand(`/bus ${'a'.repeat(128)} hi`)).toEqual({ to: 'a'.repeat(128), text: 'hi' });
  });
  it.each(['/bus', '/bus   ', '/bus leaders', '/bus leaders   ', '/bus élite hello', '/bus a\u0000b hello', `/bus ${'a'.repeat(129)} hello`])('rejects malformed input: %s', draft => {
    expect(parseBusCommand(draft)).toHaveProperty('error');
  });
});

it('builds the six-field envelope with a deterministic identity and body', () => {
  const envelope = buildMasonEnvelope({ to: 'leaders', text: 'ship today', now: 0, random: 0.5 });
  expect(envelope).toEqual({ id: 'mason-composer-0-80000000', from: 'mason', to: 'leaders', priority: 'P1', ttl: 3600, body: { text: 'ship today', source: 'Phantom desktop composer', at: '1970-01-01T00:00:00.000Z' } });
  expect(Object.keys(envelope)).toHaveLength(6);
});

it('posts one envelope using the mutation token', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue({});
  const envelope = buildMasonEnvelope({ to: 'leaders', text: 'ship today', now: 1234567890000, random: 0.5 });
  expect(await runBusCommand('/bus leaders ship today')).toEqual({ ok: true, text: `Posted to leaders on the bus · ${envelope.id}` });
  expect(post).toHaveBeenCalledExactlyOnceWith('/api/verse/agent-bus', envelope, 'fixture-token');
});

it.each([
  [404, 'Agent bus is off: fleet dispatch switch is down'],
  [503, 'Agent bus store unavailable'],
  [422, 'The server answered HTTP 422.'],
])('maps HTTP %i to a plain message', async (status, text) => {
  vi.spyOn(client, 'apiPost').mockRejectedValue(new client.ApiError('refused', status, '/api/verse/agent-bus'));
  expect(await runBusCommand('/bus leaders hello')).toEqual({ ok: false, text });
});

it('reports a locked mutation and does not post malformed input', async () => {
  const post = vi.spyOn(client, 'apiPost');
  clearMutationToken();
  expect(await runBusCommand('/bus leaders hello')).toEqual({ ok: false, text: 'Unlock actions with the mutation token before chatting.' });
  expect(await runBusCommand('/bus leaders')).toEqual({ ok: false, text: 'Enter a message to post to the agent bus.' });
  expect(post).not.toHaveBeenCalled();
});
