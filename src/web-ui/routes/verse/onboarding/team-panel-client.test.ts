import { afterEach, describe, expect, it, vi } from 'vitest';
import { inviteTeammate, readTeam } from './team-panel-client.js';

const view = { v: 1, team: 'default', members: [{ id: 'human:octocat', kind: 'human', role: 'owner', online: true, lastSeen: 'today' }], repos: [], claims: [], openHandoffs: [], pendingApprovals: [], messages: [], next: 'Ready.' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());
describe('team client', () => {
  it('parses a view and drops invalid members', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...view, members: [...view.members, { ...view.members[0], online: 'yes' }] })));
    const result = await readTeam('default');
    expect(result.state).toBe('ok');
    if (result.state === 'ok') expect(result.view.members).toEqual(view.members);
  });
  it('treats 404 as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 404)));
    expect(await readTeam('default')).toEqual({ state: 'absent' });
  });
  it.each([[400, 'That is not a GitHub username.'], [403, 'Only a team owner or admin can invite.']])('maps %s without reflecting input', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'fake-owner' }, status)));
    expect(await inviteTeammate('default', 'fake-owner', 'test')).toEqual({ state: 'error', message });
  });
});
