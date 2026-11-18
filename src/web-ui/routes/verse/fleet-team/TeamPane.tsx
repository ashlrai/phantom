import { useState, type FormEvent } from 'react';
import { directorySchema, personSchema, type TeamDirectory, type TeamPersonInput } from '../../../../shared/team-directory.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import styles from './team.module.css';

const PATH = '/api/verse/team/people';
const query: QueryDef<TeamDirectory> = { key: 'team-people', async fetch(signal) {
  const result = directorySchema.safeParse(await apiGet<unknown>(`${PATH}?team=default`, signal));
  if (!result.success) throw new Error('Team response unavailable.');
  return result.data;
} };
const list = (value: FormDataEntryValue | null) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);

export function TeamPane({ visible }: Pick<PaneProps, 'visible'>) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 }), refresh = useRefetch(query);
  const [adding, setAdding] = useState(false), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getMutationToken();
    if (!token) { setMessage('Unlock controls to add a teammate.'); return; }
    const fields = new FormData(event.currentTarget);
    const person: TeamPersonInput = { displayName: String(fields.get('displayName') ?? '').trim(),
      role: fields.get('role') as TeamPersonInput['role'], lanes: list(fields.get('lanes')), seats: list(fields.get('seats')) };
    for (const kind of ['email', 'slack', 'phone'] as const) {
      const value = String(fields.get(kind) ?? '').trim();
      if (value) person[kind] = value;
    }
    setSaving(true); setMessage('');
    try {
      const response = await apiPost<{ version?: unknown; person?: unknown; next?: unknown }>(PATH, { team: 'default', person }, token);
      if (response.version !== 1 || !personSchema.safeParse(response.person).success || typeof response.next !== 'string') throw new Error('Invalid team response');
      touchMutationHold(); setMessage(response.next); setAdding(false); refresh();
    } catch { setMessage('Could not add this teammate. Check the details and try again.'); }
    finally { setSaving(false); }
  }
  const directory = read.status === 'error' ? undefined : read.data;
  return <section className={styles.root} aria-label="Team">
    <header className={styles.header}><h2>Team</h2>{!adding && <button onClick={() => { setAdding(true); setMessage(''); }}>Add teammate</button>}</header>
    <p>People, their agents, and declared lanes. Adding a teammate does not activate pool contributions.</p>
    {!directory ? <p role="status">{read.status === 'error' ? 'Team is unavailable. Try again later.' : 'Reading team…'}</p> : <>
      {directory.orgState !== 'available' && <p>Pool contributions: {directory.orgState === 'unknown' ? 'unknown' : 'not configured'}.</p>}
      {directory.people.length === 0 ? <p>No teammates yet. Add someone to get started.</p> : <ul className={styles.people}>{directory.people.map(person => <li className={styles.person} key={person.id}>
        <div className={styles.header}><strong>{person.displayName}</strong><span>{person.role}</span><span className={styles.badge}>{person.identities.length === 0 ? 'unknown' : person.identities.every(identity => identity.state === 'verified') ? 'verified' : person.identities.some(identity => identity.state === 'unknown') ? 'unknown' : 'pending'}</span></div>
        {person.identities.map(identity => <p key={identity.kind}>{identity.kind}: {identity.value} · {identity.state}</p>)}
        <p>{person.status === 'pending' ? 'Pending teammate · ' : ''}Declared lanes: {person.lanes.length ? person.lanes.join(', ') : directory.orgState === 'unknown' ? 'unknown' : 'None listed'}</p><p>Agent seats: {person.seats.length ? person.seats.join(', ') : 'None listed'}</p>
      </li>)}</ul>}
    </>}
    {adding && <form className={styles.form} onSubmit={event => void add(event)}>
      <label>Display name<input name="displayName" required maxLength={100} autoFocus /></label>
      <label>Role<select name="role" defaultValue="viewer"><option value="founder">Founder</option><option value="engineer">Engineer</option><option value="viewer">Viewer</option></select></label>
      <label>Email<input name="email" type="email" /></label>
      <details><summary>Other identities and resources</summary>{[['slack', 'Slack ID'], ['phone', 'Phone (including country code)'], ['lanes', 'Declared lanes (comma separated)'], ['seats', 'Agent seats (comma separated)']].map(([name, label]) => <label key={name}>{label}<input name={name} /></label>)}</details>
      <p>This saves a pending record. Nothing is sent.</p><div className={styles.header}><button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add teammate'}</button><button type="button" disabled={saving} onClick={() => setAdding(false)}>Cancel</button></div>
    </form>}
    {message && <p role="status">{message}</p>}
  </section>;
}
