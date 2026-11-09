export interface LeaderOfficePanelView {
  roles: { id: string; title: string; owner: string; lane: string }[];
  priorities: { rq: string; owner: string; status: string; due: string | null; outcome: string | null }[];
  latestReply: string | null;
}

function roleRow(value: unknown): LeaderOfficePanelView['roles'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { id?: unknown; title?: unknown; owner?: unknown; lane?: unknown };
  if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.owner !== 'string' || typeof row.lane !== 'string') return null;
  return { id: row.id, title: row.title, owner: row.owner, lane: row.lane };
}

function priorityRow(value: unknown): LeaderOfficePanelView['priorities'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { rq?: unknown; owner?: unknown; status?: unknown; due?: unknown; outcome?: unknown };
  if (typeof row.rq !== 'string' || typeof row.owner !== 'string' || typeof row.status !== 'string') return null;
  if (row.due !== null && row.due !== undefined && typeof row.due !== 'string') return null;
  if (row.outcome !== null && row.outcome !== undefined && typeof row.outcome !== 'string') return null;
  return { rq: row.rq, owner: row.owner, status: row.status, due: typeof row.due === 'string' ? row.due : null, outcome: typeof row.outcome === 'string' ? row.outcome : null };
}

/** Panel shape for the Leader pane. An unrecognized payload stays hidden. */
export function narrowLeaderOffice(raw: unknown): LeaderOfficePanelView | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { org?: { roles?: unknown }; priorities?: unknown; outbox?: unknown };
  if (!Array.isArray(body.org?.roles) || !Array.isArray(body.priorities)) return null;
  const roles = body.org.roles.map(roleRow);
  const priorities = body.priorities.map(priorityRow);
  if (roles.some((row) => row === null) || priorities.some((row) => row === null)) return null;
  const outbox = Array.isArray(body.outbox) ? body.outbox : [];
  const last = outbox[outbox.length - 1];
  const latestReply = last && typeof last === 'object' && typeof (last as { text?: unknown }).text === 'string'
    ? (last as { text: string }).text : null;
  return { roles: roles as LeaderOfficePanelView['roles'], priorities: priorities as LeaderOfficePanelView['priorities'], latestReply };
}
