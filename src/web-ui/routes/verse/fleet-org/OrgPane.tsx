import { useMemo } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { VERSE_AGENT_ROSTER_PATH } from '../../../../core/verse/agent-roster-path.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { leaderQuery } from '../command/surface-data.js';
import { leaderOfficeQuery } from '../leader-thread/leader-office-data.js';
import { OrgAvatar } from './OrgAvatar.js';
import { orgExecutives, type OrgMember, type OrgStatus } from './org-roster.js';
import { MachinesRow } from './MachinesRow.js';
import { TeamRow } from './TeamRow.js';
import { OrgTree } from './OrgTree.js';
import { talkingNow, who } from '../fleet-messages/messages-model.js';
import { talkingNowQuery } from '../fleet-messages/messages-query.js';
import messageStyles from '../fleet-messages/fleet-messages.module.css';
import styles from './fleet-org.module.css';

const POLL_MS = 10_000;

export const rosterQuery: QueryDef<unknown> = { key: 'verse-fleet-agent-roster', fetch: signal => apiGet<unknown>(VERSE_AGENT_ROSTER_PATH, signal) };
const STATUS_LABEL: Record<OrgStatus, string> = { working: 'Working', idle: 'Idle', blocked: 'Blocked' };

function Card({ member }: { member: OrgMember }) {
  return <li className={styles.card} data-status={member.status}>
    <OrgAvatar avatar={member.avatar} label={member.name} />
    <div className={styles.body}>
      <strong className={styles.name}>{member.name}</strong>
      <span className={styles.role}>{member.role}</span>
      <dl className={styles.facts}>
        <div><dt>Lane</dt><dd>{member.lane ?? 'Not reported'}</dd></div>
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

/** One line per agent-to-agent conversation in the last 15 minutes (same read as `phm messages --since 15m`). */
function TalkingNow({ visible }: { visible: boolean }) {
  const read = useQuery(talkingNowQuery, { enabled: visible, freshMs: 0 });
  const lines = useMemo(() => talkingNow(read.data?.messages ?? []), [read.data]);
  const known = read.data && read.data.source !== 'unavailable';
  return <section className={styles.tier} aria-label="Talking now">
    <h3 className={styles.title}>Talking now · last 15 minutes</h3>
    {read.data === undefined && !read.error ? <p className={styles.quiet}>Reading agent messages…</p>
      : !known ? <p className={styles.quiet}>Agent messages unknown.</p>
      : lines.length === 0 ? <p className={styles.quiet}>No agents talking right now.</p>
      : <ul className={messageStyles.talk}>{lines.map(l => <li key={l.conversation}>
        <span>{who(l.a)}</span><span className={messageStyles.line} role="img" aria-label={`${l.a.name} and ${l.b.name}: ${l.messages} message${l.messages === 1 ? '' : 's'}`} /><span>{who(l.b)}</span>
      </li>)}</ul>}
  </section>;
}

/** "Leader" chip: the model the leader runs on and its plan usage; warns above 95% (same read as `phm leader seat --json`). */
function LeaderChip({ visible }: { visible: boolean }) {
  const chip = useQuery(leaderQuery, { enabled: visible, freshMs: 0 }).data?.value?.seat?.chip;
  const used = chip?.used_pct ?? null;
  const text = !chip ? 'Leader: unknown' : `Leader: ${chip.model ?? 'unknown'}${chip.lane ? ` on ${chip.lane}` : ''} · ${used === null ? 'usage unknown' : `${used}% used`}`;
  return <p className={styles.notice} role="status" aria-label="Leader" data-warn={chip?.warn ? 'true' : undefined}>
    {text}{chip?.warn ? ` — plan nearly full${chip.reset_at ? `, resets ${chip.reset_at}` : ''}. The leader moves to the next plan.` : ''}
  </p>;
}

/** The org on one screen: the `phm org` tree (leader, lanes, jobs), then the leader office's executives. */
export function OrgPane({ visible }: PaneProps) {
  const office = useQuery(leaderOfficeQuery, { enabled: visible, freshMs: 0 });
  const refetch = [useRefetch(leaderOfficeQuery), useRefetch(talkingNowQuery), useRefetch(leaderQuery)];
  usePollWhileVisible(() => refetch.forEach(r => r()), POLL_MS, { enabled: visible });
  const executives = useMemo(() => orgExecutives(office.data?.value ?? null), [office.data]);
  return <div className={styles.root}>
    <h2 className={styles.headline}>Organization</h2>
    <MachinesRow visible={visible} />
    <TeamRow visible={visible} />
    <LeaderChip visible={visible} />
    <OrgTree visible={visible} />
    {executives ? <Tier title="Executives" members={executives} empty="No executives reported." />
      : <p className={styles.notice} role="status">{office.data === undefined && office.status !== 'error' ? 'Reading the org chart…' : 'Executives not reported right now.'}</p>}
    <TalkingNow visible={visible} />
  </div>;
}
