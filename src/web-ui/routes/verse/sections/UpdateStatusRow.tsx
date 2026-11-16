import { useState } from 'react';
import { releaseChainLine } from './release-chain-line.js';
import { releaseChainQuery } from './release-chain-query.js';
import { refreshDesktopUpdates, useDesktopUpdates } from '../../../app/desktop-updates.js';
import { Button, StatusBadge, Switch } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { workersQuery } from '../fleet/workers-card-queries.js';
import { updateImpact } from '../update/update-impact.js';
import styles from './UpdateNowButton.module.css';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_VERSION, installedDesktopVersion } from './app-version.js';
import { UpdateNowButton } from './UpdateNowButton.js';
import { SettingRow } from './SettingRow.js';
import { behindLines } from './update-behind-model.js';
import { describeUpdateStatus } from './update-status-model.js';
import { updateStatusQuery } from './update-status-queries.js';
import { fetchOriginNow } from './update-fetch-client.js';
import { useFetchOriginOnFocus } from './update-fetch-on-focus.js';

import { useAutoUpdatePolicy, useAutoUpdateSentence } from './useAutoSelfUpdate.js';
import { writeAutoUpdatePolicy } from './update-auto-model.js';

function checkedAgo(at: number | null): string {
  if (at === null) return 'not checked this session';
  const seconds = Math.floor(Math.max(0, Date.now() - at) / 1000);
  if (seconds < 60) return `checked ${seconds}s ago`;
  if (seconds < 3600) return `checked ${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `checked ${Math.floor(seconds / 3600)}h ago`;
  return `checked ${Math.floor(seconds / 86400)}d ago`;
}

export function UpdateStatusRow() {
  const policy = useAutoUpdatePolicy();
  const autoSentence = useAutoUpdateSentence();
  const [checking, setChecking] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const native = useDesktopUpdates();
  const visible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(updateStatusQuery, { enabled: visible && documentVisible, freshMs: 60_000 });
  const { lastFetchAt, markFetched } = useFetchOriginOnFocus({ routeAvailable: !!query.data && !('kind' in query.data) });
  const poll = useRefetch(updateStatusQuery);
  const refresh = useRefresh(updateStatusQuery);
  usePollWhileVisible(poll, 60_000);
  const bridge = (window as unknown as { __ASHLR_DESKTOP__?: { updates?: { refresh?: unknown } } }).__ASHLR_DESKTOP__;
  const status = describeUpdateStatus({ native, server: query.status === 'error' ? null : query.data ?? null,
    appVersion: APP_VERSION, desktopVersion: installedDesktopVersion(), now: Date.now(), nativeBridge: typeof bridge?.updates?.refresh === 'function' });
  const available = ['available', 'staged', 'waiting-for-idle', 'waiting-for-app-quit', 'installed'].includes(native?.phase ?? '')
    || (!!query.data && !('kind' in query.data) && (query.data.behind ?? 0) > 0);
  const showChain = !checking && !available && (!native || native.phase === 'idle' || native.phase === 'current');
  const chain = useQuery(releaseChainQuery, { enabled: visible && documentVisible && showChain, freshMs: 60_000 });
  const pollChain = useRefetch(releaseChainQuery);
  usePollWhileVisible(pollChain, 60_000, { enabled: showChain });
  const line = showChain ? releaseChainLine(chain.data, Date.now()) : null;
  const workers = useQuery(workersQuery, { enabled: visible && documentVisible && available, freshMs: 60_000 });
  const pollWorkers = useRefetch(workersQuery);
  usePollWhileVisible(pollWorkers, 60_000, { enabled: available });
  const count = workers.status === 'success' && workers.data?.sources.workers === 'healthy' ? workers.data.workers.length : null;
  // Fleet runs are host processes launched by dispatchd in separate sessions (contrib/mac/dispatchd.py).
  const impact = updateImpact(count, true, available);
  const behind = behindLines(query.status === 'error' ? null : query.data ?? null);
  async function checkNow() {
    if (checking) return;
    setChecking(true);
    try {
      const outcome = await fetchOriginNow();
      if (outcome.kind === 'fetched') { setFetchFailed(false); markFetched(); }
      else if (outcome.kind === 'failed') setFetchFailed(true);
      if (status.canRefresh) refreshDesktopUpdates();
      refresh();
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
    <SettingRow label="Updates" description={<>
      <span aria-live="polite">{checking ? 'Checking origin…' : status.headline} · {checkedAgo(lastFetchAt)}<br />{status.detail}{fetchFailed && !checking ? ' · fetch failed' : ''}</span>
      {line && <><br /><span title={chain.data?.reason ?? undefined}>Release chain stopped at {line.step}: {line.reason} ({line.ageText})</span></>}
      {behind && <>
        <br />
        <span>Newest: {behind.first}{behind.moreCount > 0 ? ` (+${behind.moreCount} more)` : ''}</span>
        <details>
          <summary>Show all</summary>
          <ul role="list">{behind.all.map((subject, index) => <li key={index}>{subject}</li>)}</ul>
        </details>
      </>}
    </>}>
      <StatusBadge status={status.tone} tone={status.tone} />
      <Button size="sm" busy={checking} onClick={() => void checkNow()}>Check now</Button>
      <div className={styles.root}>
        {impact && <div className={styles.result} data-tone={impact.tone === 'warn' ? 'warning' : impact.tone} aria-live="polite">{impact.text}</div>}
        <UpdateNowButton status={query.data} onDone={refresh} />
      </div>
    </SettingRow>
    <SettingRow label="Update automatically when the fleet is quiet (10 min)" description={<span aria-live="polite">{policy.enabled ? autoSentence : 'Auto-update off'}</span>}>
      <Switch aria-label="Update automatically when the fleet is quiet (10 min)" checked={policy.enabled} onChange={enabled => writeAutoUpdatePolicy({ enabled, quietMinutes: 10 })} />
    </SettingRow>
    </>
  );
}
