import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { apiPost } from '../data/client.js';
import { getMutationToken, touchMutationHold } from '../data/auth-store.js';
import { MutationTokenDialog } from '../components/auth/MutationTokenDialog.js';

export function TeamInviteAccept() {
  const { team = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [invite] = useState(() => params.get('invite') ?? '');
  const [status, setStatus] = useState<'ready' | 'pending' | 'done'>('ready');
  const [error, setError] = useState('');
  const [unlock, setUnlock] = useState(false);
  async function accept() {
    if (status !== 'ready') return;
    setError('');
    const token = getMutationToken();
    if (!token) { setError('Unlock mutations to accept this invitation.'); return; }
    setStatus('pending');
    try {
      await apiPost(`/api/teams/${encodeURIComponent(team)}/invites/accept`, { token: invite }, token);
      touchMutationHold();
      setStatus('done');
      setParams({}, { replace: true });
    } catch {
      setError('Could not accept this invitation. It may have expired, been used, or belong to another team.');
      setStatus('ready');
    }
  }
  return <main id="main-content">
    <h1>Join team {team}</h1>
    <p>This joins the local human identity on this Phantom host. Invitations are single-use and expire within seven days.</p>
    {status === 'done' ? <p role="status">You joined {team}.</p> : <>
      <button type="button" onClick={() => setUnlock(true)}>Unlock actions</button>
      <MutationTokenDialog open={unlock} onClose={() => setUnlock(false)} reason="Accepting a local team invitation requires mutation authority." />
      <button type="button" disabled={!/^[a-f0-9]{64}$/.test(invite) || status === 'pending'} onClick={() => void accept()}>
        {status === 'pending' ? 'Joining…' : 'Accept invitation'}
      </button>
      {!/^[a-f0-9]{64}$/.test(invite) && <p role="alert">This invitation link is invalid.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
