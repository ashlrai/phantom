import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input } from '../../../components/primitives/index.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { QrSvg } from '../../../components/qr/QrSvg.js';
import { getMutationToken, getReadClientProof } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { Panel, SettingRow } from './SettingRow.js';
import { phoneUrlFitsQr } from './phone-access-model.js';

type Invitation = { code: string; expiresAt: number };

function useInvitation() {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!invitation) return;
    const timer = window.setTimeout(() => setInvitation(null), Math.max(0, invitation.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [invitation]);
  async function generate(issue: (token: string) => Promise<Invitation>) {
    setBusy(true);
    setError(false);
    setInvitation(null);
    try {
      const token = getMutationToken();
      if (!token) throw new Error('Actions are locked');
      const result = await issue(token);
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.code) || !Number.isSafeInteger(result.expiresAt)
        || result.expiresAt <= Date.now()) throw new Error('Invalid invitation');
      setInvitation(result);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return { invitation, busy, error, generate };
}

export function BrowserPairingRows({ unlocked }: { unlocked: boolean }) {
  const { invitation, busy, error, generate } = useInvitation();
  const toast = useToast();
  const link = invitation ? `${window.location.origin}/verse/#/pair/${invitation.code}` : null;
  async function issue(token: string): Promise<Invitation> {
    const response = await fetch('/api/session/pairing', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-ashlr-token': token, 'x-ashlr-read-client': getReadClientProof() },
    });
    if (!response.ok) throw new Error('Pairing unavailable');
    return await response.json() as Invitation;
  }
  return <Panel title="Browser pairing">
    <SettingRow label="Pair this browser" description="Use this one-time link in a browser on this computer. It expires after two minutes." stacked>
      <Button size="sm" disabled={busy || !unlocked} onClick={() => void generate(issue)}>
        {busy ? 'Creating link…' : 'Create browser pairing link'}
      </Button>
      {!unlocked && <p>Unlock actions in Connection to create a pairing link.</p>}
      {error && <p role="alert">Could not create a browser pairing link. Check your read session and action hold.</p>}
      {link && <>
        <a href={link} target="_blank" rel="noreferrer">Open browser pairing link</a>
        <Button size="sm" variant="ghost" onClick={() => void copyText(link).then((ok) => {
          toast.show(ok ? 'Browser pairing link copied.' : 'Could not reach the clipboard.');
        })}>Copy browser pairing link</Button>
      </>}
    </SettingRow>
  </Panel>;
}

export function PhonePairingRows({ phoneUrl, unlocked }: { phoneUrl: string; unlocked: boolean }) {
  const { invitation, busy, error, generate } = useInvitation();
  const [subject, setSubject] = useState('');
  const [scope, setScope] = useState<'read' | 'act'>('read');
  const link = invitation ? `${phoneUrl.replace(/\/$/, '')}/#/pair/${invitation.code}` : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    void generate((token) => apiPost<Invitation>('/api/verse/fleet/control/remote-pairing',
      { action: 'invite', subject: subject.trim(), scope }, token));
  }
  return <SettingRow label="Pair a phone" description="Create a one-time invitation for a Cloudflare Access subject. Passkey and Mac approval are still required." stacked>
    <form onSubmit={submit}>
      <label>Access subject <Input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Access <select value={scope} onChange={(event) => setScope(event.target.value === 'act' ? 'act' : 'read')}>
        <option value="read">Read only</option>
        <option value="act">Read and act</option>
      </select></label>
      <Button type="submit" size="sm" disabled={busy || !unlocked || !/^[A-Za-z0-9_-]{8,256}$/.test(subject.trim())}>
        {busy ? 'Waiting for Mac approval…' : 'Create phone invitation'}
      </Button>
    </form>
    {!unlocked && <p>Unlock actions in Connection to create an invitation.</p>}
    {error && <p role="alert">Could not create a phone invitation. Check the Access subject and confirm on this Mac.</p>}
    {link && <>
      <a href={link} target="_blank" rel="noreferrer">Open phone pairing link</a>
      {phoneUrlFitsQr(link) && <QrSvg value={link} size={192} label="Phone pairing QR code" />}
    </>}
  </SettingRow>;
}
