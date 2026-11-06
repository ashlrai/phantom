import { useEffect, useId, useState } from 'react';
import { getMutationToken } from '../../../data/auth-store.js';
import { Button } from '../../../components/primitives/index.js';
import { CopyPill } from '../apps/CopyPill.js';
import { Panel, SettingRow } from '../sections/SettingRow.js';
import { inviteTeammate, readTeam, type TeamView } from './team-panel-client.js';
import styles from './onboarding.module.css';

const TEAM = 'default';
export function TeamPanel() {
  const [view, setView] = useState<TeamView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'absent' | 'error'>('loading');
  const [user, setUser] = useState('');
  const [sending, setSending] = useState(false);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    void readTeam(TEAM, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setState(result.state);
      if (result.state === 'ok') setView(result.view);
    });
    return () => controller.abort();
  }, []);
  async function submit() {
    const token = getMutationToken();
    if (!token) { setError('Invite failed. Try phm team invite <user> in a terminal.'); return; }
    setSending(true); setError(''); setInvite('');
    const result = await inviteTeammate(TEAM, user.trim(), token);
    if (result.state === 'ok') setInvite(result.view.invite);
    else if (result.state === 'error') setError(result.message);
    setSending(false);
  }
  return <Panel title="Team">
    {state === 'loading' && <p className={styles.teamMuted}>Loading team…</p>}
    {state === 'absent' && <p className={styles.teamMuted}>Team view needs Phantom 3.30 or later. From a terminal: phm team view</p>}
    {state === 'error' && <p className={styles.teamMuted}>Team view is unavailable.</p>}
    {state === 'ok' && view && <>
      <p className={styles.teamMuted}>{view.members.length} members, {view.members.filter(member => member.online).length} online · {view.openHandoffs.length} open handoffs · {view.pendingApprovals.length} approvals waiting<br />{view.next}</p>
      <ul className={styles.teamList}>{view.members.map(member => <li className={styles.teamRow} key={member.id}>
        <span><span className={styles.teamDot} data-online={member.online} aria-label={member.online ? 'Online' : 'Offline'} /> {member.id.replace(/^human:/, '')}</span><span className={styles.teamRole}>{member.role}</span>
      </li>)}</ul>
      {view.pendingApprovals.map(approval => <div className={styles.teamRow} key={approval.id}><span>{approval.action}</span><code className={styles.code}>phm team approve {approval.id} --team {TEAM}</code></div>)}
      <SettingRow label="Invite a teammate" htmlFor={id} stacked>
        <div className={styles.teamInvite}><input id={id} value={user} onChange={event => setUser(event.target.value)} placeholder="GitHub username" />
          <Button size="sm" onClick={() => void submit()} disabled={!user.trim() || sending}>{sending ? 'Inviting…' : 'Invite'}</Button></div>
      </SettingRow>
      {error && <p className={styles.teamMuted} role="alert">{error}</p>}
      {invite && <div className={styles.teamResult}><code className={styles.code}>{invite}</code> <CopyPill text={invite} label="Copy" what="invite" /><p>They run: <code>phm team join &lt;invite&gt;</code></p><p>Grants team membership only. No passwords, keys or repo access.</p></div>}
    </>}
  </Panel>;
}
