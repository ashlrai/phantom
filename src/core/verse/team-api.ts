/** Desktop surface for team onboarding: read the local team log and invite a GitHub user (the `phm team view|invite` verbs). */
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { localHumanActor } from '../teams/identity.js';
import { inviteMember, memberIdForGithubUser } from '../teams/membership.js';
import { validId, type TeamActor } from '../teams/protocol.js';
import { teamState, type TeamState } from '../teams/state.js';
import { DEFAULT_TEAM } from '../teams/tools.js';

export const VERSE_TEAM_PATH = '/api/verse/team';
export const VERSE_TEAM_INVITE_PATH = '/api/verse/team/invite';

export interface TeamApiDeps {
  /** Default: teamState — the folded local event log. */
  readTeam?: (team: string) => TeamState;
  /** Default: inviteMember — the locked append, with its own owner/admin check. */
  invite?: typeof inviteMember;
  /** Default: localHumanActor — this node's OS-user identity, never a request field. */
  actor?: () => TeamActor;
}

const TEXT_MAX = 280;
// Same private-path shapes fleet-cos-api refuses: free text carrying one is blanked.
const PRIVATE_PATH = /(?:\/Users\/|\/home\/|~\/|[A-Z]:\\)/;
// The workspace's refusal texts (assertLocalHuman + the role check), all "not an owner/admin".
const REFUSED = /owner\/admin|only humans|agent process|not accepted|team owner/i;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasExactKeys = (body: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(body).length === keys.length && keys.every(k => typeof body[k] === 'string');
// teamDir (store.ts) refuses exactly these spellings; check before a read can throw.
const validTeamId = (team: unknown): team is string => validId(team) && !team.includes('/') && !team.includes('..');
// Free text on the wire: secret-scrubbed and bounded; a private path shape becomes ''.
const wireText = (value: unknown): string =>
  typeof value === 'string' && !PRIVATE_PATH.test(value) ? scrubSecrets(value).slice(0, TEXT_MAX) : '';

async function jsonBody(req: Parameters<ApiModule>[1]): Promise<unknown> {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

const unavailable = (res: Parameters<ApiModule>[2]): void => {
  sendJson(res, 503, { code: 'TEAM_UNAVAILABLE', error: 'team state unavailable' });
};
const refused = (res: Parameters<ApiModule>[2]): void => {
  sendJson(res, 403, { code: 'TEAM_REFUSED', error: 'Only a team owner or admin can invite.' });
};

export function createTeamApi(deps: TeamApiDeps = {}): ApiModule {
  const readTeam = deps.readTeam ?? teamState;
  const invite = deps.invite ?? inviteMember;
  const actor = deps.actor ?? localHumanActor;

  function view(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): void {
    let team: string;
    try { team = new URL(req.url ?? '/', 'http://localhost').searchParams.get('team') ?? DEFAULT_TEAM; } catch { team = DEFAULT_TEAM; }
    if (!validTeamId(team)) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid team' }); return; }
    let state: TeamState;
    try { state = readTeam(team); } catch { unavailable(res); return; }
    sendJson(res, 200, {
      v: 1,
      team,
      members: state.members.map((m) => ({
        id: m.id, kind: m.kind, role: m.role, online: m.online, lastSeen: m.lastSeen,
        ...(m.status !== undefined ? { status: wireText(m.status) } : {}),
      })),
      repos: state.repos,
      claims: state.claims.map((c) => ({
        repo: c.target.repo,
        ...(c.target.branch ? { branch: wireText(c.target.branch) } : {}),
        ...(c.target.path ? { path: wireText(c.target.path) } : {}),
        holder: c.holder, expiresAt: c.expiresAt,
      })),
      openHandoffs: state.handoffs
        .filter((h) => h.state !== 'completed' && h.state !== 'declined')
        .map((h) => ({ id: h.id, title: wireText(h.title), state: h.state, from: h.from, assignee: h.assignee ?? h.to ?? '' })),
      pendingApprovals: state.approvals
        .filter((a) => a.state === 'pending')
        .map((a) => ({ id: a.id, action: a.action, requestedBy: a.requestedBy })),
      messages: state.messages.slice(-5).map((m) => ({ from: m.from, channel: wireText(m.channel), ts: m.ts, text: wireText(m.text) })),
      next: state.members.length === 0
        ? `Confirm this is the intended local log with the team owner, then join from a human terminal: phm team join --team ${team}`
        : 'Confirm your role and task with the owner.',
    });
  }

  async function inviteMemberRoute(req: Parameters<ApiModule>[1], res: Parameters<ApiModule>[2]): Promise<void> {
    const body = await jsonBody(req);
    if (!record(body) || !hasExactKeys(body, ['team', 'githubUser'])) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid invite body' }); return;
    }
    const team = body.team as string;
    const githubUser = body.githubUser as string;
    if (!validTeamId(team)) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid team' }); return; }
    // memberIdForGithubUser's own message echoes the input; the wire gets fixed text.
    try { memberIdForGithubUser(githubUser); } catch {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid GitHub username' }); return;
    }
    let who: TeamActor;
    try { who = actor(); } catch { refused(res); return; }
    try {
      const r = invite(team, who, githubUser);
      sendJson(res, 201, { v: 1, team: r.team, member: r.member, invite: r.invite, grants: r.grants, next: r.next });
    } catch (error) {
      if (error instanceof Error && REFUSED.test(error.message)) refused(res);
      else unavailable(res);
    }
  }

  return async (ctx, req, res, path, method) => {
    const route = path === VERSE_TEAM_PATH ? 'view' : path === VERSE_TEAM_INVITE_PATH ? 'invite' : null;
    if (route === null) return false;
    if (method !== (route === 'view' ? 'GET' : 'POST')) {
      sendJson(res, 405, { error: 'method not allowed' }); return true;
    }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (method === 'POST' && !passesMutationGate(req, res, ctx.token)) return true;
    if (route === 'view') view(req, res);
    else await inviteMemberRoute(req, res);
    return true;
  };
}

export const handleTeamApi: ApiModule = createTeamApi();
