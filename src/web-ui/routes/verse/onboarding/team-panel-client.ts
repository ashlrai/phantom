import { apiGet, apiPost, ApiError } from '../../../data/client.js';

/** Mirrored desktop wire contract; deliberately independent of src/core. */
export interface TeamView {
  v: 1; team: string;
  members: { id: string; kind: 'human' | 'agent'; role: string; online: boolean; lastSeen: string; status?: string }[];
  repos: string[];
  claims: { repo: string; branch?: string; path?: string; holder: string; expiresAt: string }[];
  openHandoffs: { id: string; title: string; state: string; from: string; assignee: string }[];
  pendingApprovals: { id: string; action: string; requestedBy: string }[];
  messages: { from: string; channel: string; ts: string; text: string }[];
  next: string;
}
interface Invite { v: 1; team: string; member: string; invite: string; grants: 'membership-only'; next: string }
type Result<T> = { state: 'ok'; view: T } | { state: 'absent' } | { state: 'error'; message: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every(k => typeof v[k] === 'string');
const optional = (v: Record<string, unknown>, keys: string[]) => keys.every(k => v[k] === undefined || typeof v[k] === 'string');
const row = (v: unknown, keys: string[], opts: string[] = []) => object(v) && strings(v, keys) && optional(v, opts);

function parseView(v: unknown): TeamView | null {
  if (!object(v) || v.v !== 1 || !strings(v, ['team', 'next']) ||
    !['members', 'repos', 'claims', 'openHandoffs', 'pendingApprovals', 'messages'].every(k => Array.isArray(v[k]))) return null;
  return {
    v: 1, team: v.team as string, next: v.next as string,
    members: (v.members as unknown[]).filter(x => row(x, ['id', 'role', 'lastSeen'], ['status']) && object(x) && (x.kind === 'human' || x.kind === 'agent') && typeof x.online === 'boolean') as TeamView['members'],
    repos: (v.repos as unknown[]).filter((x): x is string => typeof x === 'string'),
    claims: (v.claims as unknown[]).filter(x => row(x, ['repo', 'holder', 'expiresAt'], ['branch', 'path'])) as TeamView['claims'],
    openHandoffs: (v.openHandoffs as unknown[]).filter(x => row(x, ['id', 'title', 'state', 'from', 'assignee'])) as TeamView['openHandoffs'],
    pendingApprovals: (v.pendingApprovals as unknown[]).filter(x => row(x, ['id', 'action', 'requestedBy'])) as TeamView['pendingApprovals'],
    messages: (v.messages as unknown[]).filter(x => row(x, ['from', 'channel', 'ts', 'text'])) as TeamView['messages'],
  };
}

export async function readTeam(team: string, signal?: AbortSignal): Promise<Result<TeamView>> {
  try {
    const view = parseView(await apiGet<unknown>(`/api/verse/team?team=${encodeURIComponent(team)}`, signal));
    return view ? { state: 'ok', view } : { state: 'error', message: 'Team view is unavailable.' };
  } catch (error) {
    if ((error instanceof ApiError && error.status === 404) || error instanceof TypeError) return { state: 'absent' };
    return { state: 'error', message: 'Team view is unavailable.' };
  }
}

export async function inviteTeammate(team: string, githubUser: string, token: string): Promise<Result<Invite>> {
  try {
    const v = await apiPost<unknown>('/api/verse/team/invite', { team, githubUser }, token);
    if (object(v) && v.v === 1 && v.grants === 'membership-only' && strings(v, ['team', 'member', 'invite', 'next'])) return { state: 'ok', view: v as unknown as Invite };
    throw new Error('Invalid invite response');
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return { state: 'error', message: status === 400 ? 'That is not a GitHub username.' : status === 403 ? 'Only a team owner or admin can invite.' : 'Invite failed. Try phm team invite <user> in a terminal.' };
  }
}
