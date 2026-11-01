import { useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { apiPost, readFailureReason } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { SettingRow } from './SettingRow.js';
import { pairedDevicesQuery } from './paired-devices-query.js';
import { approveOutcomeText, pendingTell } from './pending-phones-model.js';
import { pendingPhonesQuery } from './pending-phones-query.js';

export function PendingPhoneRows() {
  const read = useQuery(pendingPhonesQuery);
  const refetch = useRefetch(pendingPhonesQuery);
  const hold = useMutationHold();
  const toast = useToast();
  const inFlight = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  usePollWhileVisible(refetch, 15_000);

  async function decide(action: 'approve' | 'deny', id: string) {
    const token = getMutationToken();
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setPending(id);
    try {
      const response = await apiPost<{ v: 1; result: unknown }>('/api/verse/fleet/control/remote-pairing', { action, id }, token);
      touchMutationHold();
      toast.show(approveOutcomeText(response?.v === 1 ? response.result : null));
    } catch (error) {
      toast.show(readFailureReason(error), 'danger');
    } finally {
      await Promise.all([
        refetchQuery(pendingPhonesQuery.key, () => pendingPhonesQuery.fetch(), true),
        refetchQuery(pairedDevicesQuery.key, () => pairedDevicesQuery.fetch(), true),
      ]);
      inFlight.current = false;
      setPending(null);
    }
  }

  if (read.error && !read.data) return <p>Pending phones unavailable.</p>;
  if (!read.data || 'kind' in read.data) return null;
  const { approvals, gateway } = read.data;
  if (!approvals.length && gateway === 'running') return null;
  return <>
    <p>{pendingTell(approvals.length, gateway)}</p>
    {approvals.map(phone => <SettingRow key={phone.id}
      label={[phone.label, phone.email, phone.deviceType].filter(Boolean).join(' · ')}
      description={pending === phone.id ? 'Confirm on the Mac dialog…' : undefined} stacked>
      <Button size="sm" variant="primary" disabled={!hold.hasHold || pending !== null} onClick={() => void decide('approve', phone.id)}>Approve</Button>
      <Button size="sm" variant="ghost" disabled={!hold.hasHold || pending !== null} onClick={() => void decide('deny', phone.id)}>Deny</Button>
    </SettingRow>)}
    {!hold.hasHold && approvals.length > 0 && <p>Unlock the mutation hold to approve or deny a phone.</p>}
  </>;
}
