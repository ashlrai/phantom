/**
 * routes/verse/mobile/MobileReleaseCard.tsx — the release train in a pocket:
 * one line on the Fleet screen saying whether the release-please PR is
 * blocked, waiting on checks, or ready to merge. Same query key as the Mac's
 * Releases pane, so the two never disagree. A 404 means this build has no
 * release route and the card renders nothing.
 */
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { releasePrQuery, type ReleasePr, type ReleasePrResult } from '../fleet/release-pr-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { cx, SkeletonList } from './ui.js';
import { Row, Section, ui } from './ui-parts.js';

const REPO_NAME = 'phantom';

/** The fleet's release repo, matched like the desktop pane: basename, case-free. */
function releaseRepoPr(result: ReleasePrResult, repoName: string): ReleasePr | null {
  if (result.kind !== 'available') return null;
  const wanted = repoName.toLowerCase();
  return result.data.repos.find(({ repo }) => {
    const name = repo.toLowerCase();
    return name === wanted || name.endsWith(`/${wanted}`);
  })?.pr ?? null;
}

/** The one line the card shows; null when this build has no release read. */
export function releaseLine(result: ReleasePrResult | undefined, repoName = 'phantom'): string | null {
  if (!result || result.kind === 'notInBuild') return null;
  const pr = releaseRepoPr(result, repoName);
  if (!pr) return 'No release PR open';
  const head = pr.version ? `v${pr.version} candidate` : 'Release candidate';
  const state = pr.blocked ? `blocked: ${pr.failing.join(', ')}`
    : pr.pending > 0 ? `${pr.pending} checks pending`
    : 'ready to merge';
  return `${head} · PR #${pr.number} · ${state}`;
}

/** The phone opens a PR page only on github.com over http(s) — never another host. */
function releasePrHref(url: string): string | null {
  if (!url || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === 'github.com'
      ? parsed.href : null;
  } catch {
    return null;
  }
}

export function MobileReleaseCard() {
  const query = useQuery(releasePrQuery, { freshMs: 0 });
  const refetch = useRefetch(releasePrQuery);
  usePollWhileVisible(refetch, 60_000);

  const result = query.data;
  if (result?.kind === 'notInBuild') return null;

  const pr = result ? releaseRepoPr(result, REPO_NAME) : null;
  const href = pr ? releasePrHref(pr.url) : null;

  return (
    <Section
      title="Release"
      flat
      trailing={href ? <a className={cx(ui.btn, ui.plain)} href={href} target="_blank" rel="noopener noreferrer">Open PR</a> : undefined}
    >
      {result === undefined && query.status !== 'error' ? (
        <SkeletonList rows={1} label="Loading release state" />
      ) : result === undefined ? (
        <Row
          title={<span className={ui.muted}>Release state unavailable</span>}
          subtitle={<span className={ui.muted}>{readFailureReason(query.error)}</span>}
        />
      ) : (
        <Row title={releaseLine(result, REPO_NAME)} subtitle={pr?.summary} />
      )}
    </Section>
  );
}
