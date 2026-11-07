import { Component, type ReactNode } from 'react';
import { Button, StatusBadge } from '../../../components/primitives/index.js';
import { QrSvg } from '../../../components/qr/QrSvg.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Panel, SettingRow } from './SettingRow.js';
import { inviteCommand, phoneAccessTell, phoneUrlFitsQr } from './phone-access-model.js';
import { phoneAccessQuery } from './phone-access-query.js';

// Optional card: if it ever fails to render, hide it rather than take the
// whole Connection panel down (same rule as DockHelperBoundary).
class PhoneAccessBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    console.warn('[verse] phone access card failed and was hidden');
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function PhoneAccessRows() {
  return <PhoneAccessBoundary><PhoneAccessRowsView /></PhoneAccessBoundary>;
}

function PhoneAccessRowsView() {
  const read = useQuery(phoneAccessQuery);
  const refetch = useRefetch(phoneAccessQuery);
  const toast = useToast();
  usePollWhileVisible(refetch, 30_000);
  if (read.data && 'kind' in read.data) return null;
  async function copy(text: string, label: string) {
    const ok = await copyText(text);
    toast.show(ok ? `${label} copied.` : 'Could not reach the clipboard.', ok ? undefined : 'danger');
  }
  const data = read.data;
  return <Panel title="Phone">
    {read.error ? <p>Phone access unavailable.</p> : !data ? <p>Loading phone access…</p> : <>
      <SettingRow label={phoneAccessTell(data)}>
        <StatusBadge status={data.gateway === 'running' ? 'running' : 'not running'} tone={data.gateway === 'running' ? 'success' : 'neutral'} />
      </SettingRow>
      {data.phoneUrl && <SettingRow label="Phone URL" stacked>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-2)', minWidth: 0 }}>
          <a href={data.phoneUrl} target="_blank" rel="noopener noreferrer">{data.phoneUrl}</a>
          <Button size="sm" variant="ghost" onClick={() => void copy(data.phoneUrl!, 'Phone URL')}>Copy phone URL</Button>
          {phoneUrlFitsQr(data.phoneUrl) && <QrSvg value={data.phoneUrl} size={128} label="Phone URL QR code" />}
        </div>
      </SettingRow>}
      <SettingRow label={`${data.pending} pairing${data.pending === 1 ? ' waits' : 's wait'} for you below`}>
        <Button size="sm" variant="ghost" onClick={() => void copy(inviteCommand(), 'Invite command')}>Copy invite command</Button>
      </SettingRow>
    </>}
  </Panel>;
}
