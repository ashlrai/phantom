/**
 * routes/verse/mobile/MobileReleaseCard.tsx — the release train in a pocket:
 * one line on the Fleet screen saying whether the release-please PR is
 * blocked, waiting on checks, or ready to merge. Same query key as the Mac's
 * Releases pane, so the two never disagree. A 404 means this build has no
 * release route and the card renders nothing.
 */
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ciRunsQuery } from '../fleet-releases/fleet-releases-queries.js';
import { releasePrQuery, type ReleasePr, type ReleasePrResult } from '../fleet/release-pr-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { cx, SkeletonList } from './ui.js';
import { releaseCiRow } from './release-ci-model.js';
import { releaseVerdictLine } from './release-verdict-model.js';
import { Badge, Row, Section, ui } from './ui-parts.js';

const REPO_NAME = 'phantom';

/** The fleet's release repo, matched like the desktop pane: basename, case-free. */
function releaseRepo(result: ReleasePrResult, repoName: string): { pr: ReleasePr | null } | null {
  if (result.kind !== 'available') return null;
  const wanted = repoName.toLowerCase();
  return result.data.repos.find(({ repo }) => {
    const name = repo.toLowerCase();
    return name === wanted || name.endsWith(`/${wanted}`);
  }) ?? null;
}

/** The one line the card shows; null when this build has no release read. */
export function releaseLine(result: ReleasePrResult | undefined, repoName = 'phantom'): string | null {
  if (!result || result.kind === 'notInBuild') return null;
  const entry = releaseRepo(result, repoName);
  const pr = entry?.pr;
  if (!pr) return 'No release PR open';
  const verdict = releaseVerdictLine(entry, pr.version);
  if (!pr.blocked && pr.pending === 0 && verdict.blocked && verdict.line) return verdict.line;
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
  const ciQuery = useQuery(ciRunsQuery, { freshMs: 0 });
  const refetchCi = useRefetch(ciRunsQuery);
  usePollWhileVisible(refetchCi, 60_000);

  const result = query.data;
  if (result?.kind === 'notInBuild') return null;

  const entry = result ? releaseRepo(result, REPO_NAME) : null;
  const pr = entry?.pr ?? null;
  const verdict = releaseVerdictLine(entry, pr?.version ?? null);
  const showVerdict = pr && !pr.blocked && pr.pending === 0 && verdict.blocked && verdict.line;
  const href = pr ? releasePrHref(pr.url) : null;
  const ci = releaseCiRow(ciQuery.data, Date.now());

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
        <Row title={showVerdict ? <span data-tone="warning"><Badge tone="warning">{showVerdict}</Badge></span> : releaseLine(result, REPO_NAME)} subtitle={showVerdict ? undefined : pr?.summary} />
      )}
      {ci ? <Row
        title={<span data-tone={ci.tone}><Badge tone={ci.tone === 'ok' ? 'success' : ci.tone === 'bad' ? 'danger' : 'neutral'}>{ci.title}</Badge></span>}
        trailing={ci.href ? <a className={cx(ui.btn, ui.plain)} href={ci.href} target="_blank" rel="noopener noreferrer">Open run</a> : undefined}
      /> : null}
    </Section>
  );
}
