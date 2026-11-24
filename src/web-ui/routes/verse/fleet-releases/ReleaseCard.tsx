import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Card } from '../command/Surface.js';
import { Button } from '../../../components/primitives/Button.js';
import { releaseChainQuery } from '../sections/release-chain-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

export function ReleaseCard({ visible }: { visible: boolean }) {
  const read = useQuery(releaseChainQuery, { enabled: visible, freshMs: 60_000 });
  const refresh = useRefetch(releaseChainQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const [showLog, setShowLog] = useState(false);
  const r = read.status === 'error' ? undefined : read.data?.release;
  const due = r?.nextCandidate.eta ? Date.parse(r.nextCandidate.eta) <= Date.now() : false;
  const log = read.status === 'error' ? 'Log unavailable: release status could not be fetched.'
    : read.status === 'idle' || read.status === 'loading' ? 'Loading release log…'
      : r?.autorun.log || 'Log unknown: no local log was recorded.';
  return <Card title="Release" caption="Last recorded locally" actions={<Button size="sm" variant="ghost" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>See log</Button>}>
    <p>Published: {r?.latestPublishedTag ?? 'unknown'} · {r?.publishedAt ?? 'time unknown'}</p>
    <p>Signed assets: {r?.signedAssets == null ? 'unknown' : r.signedAssets ? 'complete' : 'missing'} · Updater HTTP: {r?.updaterHttp ?? 'unknown'} · Recorded: {r?.recordedAt ?? 'unknown'}</p>
    <p>Merged PRs since tag: {r?.mergedPrsSinceTag ?? 'unknown'}</p>
    <p>Next: {r?.nextCandidate.version ?? 'unknown'} · Earliest: {r?.nextCandidate.eta ?? 'unknown'}{due ? ' (due)' : ''} · Cadence: {r?.nextCandidate.cadenceMinutes ?? 'unknown'} minutes</p>
    <p>Autorun rc: {r?.autorun.rc ?? 'unknown'} · {r?.autorun.reason ?? 'Reason: unknown'}</p>
    {showLog && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>{log}</pre>}
  </Card>;
}
