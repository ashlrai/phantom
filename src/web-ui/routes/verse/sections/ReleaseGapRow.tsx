import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { opsReleasesQuery } from '../fleet-releases/fleet-releases-queries.js';
import { releasePrQuery } from '../fleet/release-pr-query.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_VERSION, installedDesktopVersion } from './app-version.js';
import { compareReleaseTags, releaseGapText, releaseNotesUrl, unshippedText } from './release-gap-model.js';
import { SettingRow } from './SettingRow.js';

const RELEASE_POLL_MS = 5 * 60_000;

export function ReleaseGapRow() {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const visible = sectionVisible && documentVisible;
  const read = useQuery(opsReleasesQuery, { enabled: visible, freshMs: RELEASE_POLL_MS });
  const poll = useRefetch(opsReleasesQuery);
  usePollWhileVisible(poll, RELEASE_POLL_MS, { refreshOnShow: false });
  const repo = read.status === 'error' ? undefined : read.data?.repos.find(
    item => item.repo.toLowerCase() === 'ashlrai/phantom' || item.repo.toLowerCase() === 'phantom',
  ) ?? (read.status === 'error' ? undefined : read.data?.repos.find(item => item.repo.toLowerCase().endsWith('/phantom')));
  const hasUnshipped = (repo?.commitsSinceTag ?? 0) > 0;
  const prRead = useQuery(releasePrQuery, { enabled: visible && hasUnshipped, freshMs: RELEASE_POLL_MS });
  const pollPr = useRefetch(releasePrQuery);
  usePollWhileVisible(pollPr, RELEASE_POLL_MS, { enabled: hasUnshipped, refreshOnShow: false });
  const prRepos = prRead.status !== 'error' && prRead.data?.kind === 'available' ? prRead.data.data.repos : [];
  const pr = (prRepos.find(item => item.repo.toLowerCase() === repo?.repo.toLowerCase())
    ?? prRepos.find(item => item.repo.toLowerCase() === 'ashlrai/phantom')
    ?? prRepos.find(item => item.repo.toLowerCase().endsWith('/phantom')))?.pr;
  const unshipped = unshippedText({ commitsSinceTag: repo?.commitsSinceTag ?? null, prNumber: pr?.number ?? null, prBlocked: pr?.blocked ?? null });
  const tag = repo?.gh?.latestRelease?.tag || null;
  const view = compareReleaseTags(installedDesktopVersion() ?? APP_VERSION, tag);
  const text = read.status === 'loading' || read.status === 'idle' ? 'Reading releases…' : releaseGapText(view);

  return <SettingRow label={<span aria-live="polite">{text}</span>} description={unshipped && <span aria-live="polite">
    {unshipped} · <a href="#" onClick={event => { event.preventDefault(); openDockPane('fleet-releases'); }}>Open Releases pane</a>
  </span>}>
    {tag && <a href={releaseNotesUrl(tag)} target="_blank" rel="noreferrer">Release notes</a>}
    {!unshipped && <Button size="sm" onClick={() => openDockPane('fleet-releases')}>Open Releases pane</Button>}
  </SettingRow>;
}
