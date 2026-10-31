import { refreshDesktopUpdates, useDesktopUpdates } from '../../../app/desktop-updates.js';
import { Button, StatusBadge } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_VERSION, installedDesktopVersion } from './app-version.js';
import { SettingRow } from './SettingRow.js';
import { describeUpdateStatus } from './update-status-model.js';
import { updateStatusQuery } from './update-status-queries.js';

export function UpdateStatusRow() {
  const native = useDesktopUpdates();
  const visible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(updateStatusQuery, { enabled: visible && documentVisible, freshMs: 60_000 });
  const poll = useRefetch(updateStatusQuery);
  const refresh = useRefresh(updateStatusQuery);
  usePollWhileVisible(poll, 60_000);
  const bridge = (window as unknown as { __ASHLR_DESKTOP__?: { updates?: { refresh?: unknown } } }).__ASHLR_DESKTOP__;
  const status = describeUpdateStatus({ native, server: query.status === 'error' ? null : query.data ?? null,
    appVersion: APP_VERSION, desktopVersion: installedDesktopVersion(), now: Date.now(), nativeBridge: typeof bridge?.updates?.refresh === 'function' });
  return (
    <SettingRow label="Updates" description={<span aria-live="polite">{status.headline}<br />{status.detail}</span>}>
      <StatusBadge status={status.tone} tone={status.tone} />
      <Button size="sm" onClick={() => { if (status.canRefresh) refreshDesktopUpdates(); refresh(); }}>Check now</Button>
    </SettingRow>
  );
}
