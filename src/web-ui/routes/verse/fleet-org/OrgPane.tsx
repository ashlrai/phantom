import { useMemo } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { VerseSeat } from '../../../../core/verse/types.js';
import { VERSE_AGENT_ROSTER_PATH } from '../../../../core/verse/agent-roster-path.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fleetUsageRunsQuery } from '../fleet-usage/fleet-usage-queries.js';
import { leaderOfficeQuery } from '../leader-thread/leader-office-data.js';
import { OrgAvatar } from './OrgAvatar.js';
import { buildOrgRoster, type OrgMember, type OrgStatus } from './org-roster.js';
import styles from './fleet-org.module.css';

const POLL_MS = 10_000;

export const rosterQuery: QueryDef<unknown> = { key: 'verse-fleet-agent-roster', fetch: signal => apiGet<unknown>(VERSE_AGENT_ROSTER_PATH, signal) };
const seatsQuery: QueryDef<readonly VerseSeat[] | null> = {
  key: 'verse-org-seats',
  fetch: async signal => {
    try {
      const body = await apiGet<{ seats?: unknown }>('/api/verse/seats', signal);
      return Array.isArray(body.seats) ? body.seats as VerseSeat[] : null;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return null;
    }
  },
};

const STATUS_LABEL: Record<OrgStatus, string> = { working: 'Working', idle: 'Idle', blocked: 'Blocked', held: 'Held', unknown: 'Unknown' };

function Card({ member }: { member: OrgMember }) {
  return <li className={styles.card} data-tier={member.tier} data-status={member.status}>
    <OrgAvatar avatar={member.avatar} label={member.name} />
    <div className={styles.body}>
      <strong className={styles.name}>{member.name}</strong>
      <span className={styles.role}>{member.role}</span>
      <dl className={styles.facts}>
        <div><dt>Model</dt><dd>{member.model ?? 'Not reported'}</dd></div>
        <div><dt>Lane</dt><dd>{member.lane ?? 'Not reported'}</dd></div>
        {member.claims !== null && <div><dt>Claims</dt><dd>{member.claims}</dd></div>}
      </dl>
    </div>
    <span className={styles.status} data-status={member.status} title={member.detail ?? undefined}>
      <span className={styles.dot} aria-hidden="true" />{STATUS_LABEL[member.status]}
      {member.detail && <small>{member.detail}</small>}
    </span>
  </li>;
}

function Tier({ title, members, empty }: { title: string; members: OrgMember[]; empty: string }) {
  return <section className={styles.tier} aria-label={title}>
    <h3 className={styles.title}>{title}</h3>
    {members.length === 0 ? <p className={styles.quiet}>{empty}</p> : <ul className={styles.list}>{members.map(m => <Card key={m.id} member={m} />)}</ul>}
  </section>;
}

const SOURCE_NAMES = { office: 'org chart', lanes: 'fleet lanes', roster: 'claims', seats: 'models' } as const;

export function OrgPane({ visible }: PaneProps) {
  const office = useQuery(leaderOfficeQuery, { enabled: visible, freshMs: 0 });
  const runs = useQuery(fleetUsageRunsQuery, { enabled: visible, freshMs: 0 });
  const roster = useQuery(rosterQuery, { enabled: visible, freshMs: 0 });
  const seats = useQuery(seatsQuery, { enabled: visible, freshMs: 0 });
  const refetch = [useRefetch(leaderOfficeQuery), useRefetch(fleetUsageRunsQuery), useRefetch(rosterQuery), useRefetch(seatsQuery)];
  usePollWhileVisible(() => refetch.forEach(r => r()), POLL_MS, { enabled: visible });

  const loading = [office, runs, roster, seats].some(q => q.data === undefined && q.status !== 'error');
  const org = useMemo(() => buildOrgRoster({
    office: office.data?.value ?? null, runs: runs.data, roster: roster.data, seats: seats.data ?? null,
  }), [office.data, runs.data, roster.data, seats.data]);
  if (loading) return <div className={styles.root} role="status">Reading the organization…</div>;

  const down = (Object.keys(org.sources) as (keyof typeof org.sources)[]).filter(k => org.sources[k] === 'unavailable');
  return <div className={styles.root}>
    <h2 className={styles.headline}>Organization · {org.executives.length} executive{org.executives.length === 1 ? '' : 's'} · {org.teammates.length} teammate{org.teammates.length === 1 ? '' : 's'}</h2>
    {down.length > 0 && <p className={styles.notice} role="status">Not reported right now: {down.map(k => SOURCE_NAMES[k]).join(', ')}.</p>}
    <Tier title="Leader" members={[org.leader]} empty="" />
    <Tier title="Executives" members={org.executives} empty="No executives reported." />
    <Tier title="Teammates" members={org.teammates} empty="No lanes reported." />
  </div>;
}
