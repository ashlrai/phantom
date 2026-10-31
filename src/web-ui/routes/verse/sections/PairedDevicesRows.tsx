import { Button, StatusBadge } from '../../../components/primitives/index.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Panel, SettingRow } from './SettingRow.js';
import { lastUsedText, revokeCommand, sortDevices } from './paired-devices-model.js';
import { pairedDevicesQuery } from './paired-devices-query.js';

export function PairedDevicesRows() {
  const read = useQuery(pairedDevicesQuery);
  const refetch = useRefetch(pairedDevicesQuery);
  const toast = useToast();
  usePollWhileVisible(refetch, 60_000);
  if (read.data && 'kind' in read.data) return null;
  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      toast.show('Revoke command copied.');
    } catch {
      toast.show('Could not reach the clipboard — select the command and copy manually.', 'danger');
    }
  }
  return <Panel title="Paired devices">
    {read.error ? <p>Paired devices unavailable.</p> : !read.data ? <p>Loading paired devices…</p>
      : read.data.devices.length === 0 ? <p>No phones are paired. Run <code>phm verse remote invite &lt;Access-subject&gt;</code> to pair one.</p>
        : sortDevices(read.data.devices).map(device => {
          const command = revokeCommand(device.id);
          return <SettingRow key={device.id} label={<>{device.label} · {device.email}</>}
            description={<>Created {device.createdAt} · {lastUsedText(device.lastUsedAt, Date.now())}</>} stacked>
            <StatusBadge status={device.revokedAt === null ? 'active' : 'revoked'} tone={device.revokedAt === null ? 'success' : 'neutral'} />
            <StatusBadge status={device.act ? 'read + act' : 'read'} tone="neutral" />
            {command && <><code>{command}</code><Button size="sm" variant="ghost" onClick={() => void copy(command)}>Copy revoke command</Button></>}
          </SettingRow>;
        })}
  </Panel>;
}
