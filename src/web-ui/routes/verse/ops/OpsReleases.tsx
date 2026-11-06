/**
 * routes/verse/ops/OpsReleases.tsx : read-only release status for every
 * enrolled repo: the checked-out version, the newest tag, the release
 * workflow file, and what gh last reported (latest release, latest run).
 * Nothing here publishes or deploys; a repo whose state could not be read
 * says UNKNOWN rather than guessing.
 */
import { useRefetch, useQuery } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { opsReleasesQuery } from './ops-queries.js';
import type { OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import styles from './ops.module.css';

function runLabel(run: NonNullable<NonNullable<OpsRepoReleaseV1['gh']>['latestRun']>): string {
  if (run.status === 'completed') return run.conclusion ?? 'completed';
  return run.status;
}

function RepoRow({ repo }: { repo: OpsRepoReleaseV1 }) {
  return (
    <div className={styles.row}>
      <p className={styles.rowTitle}>
        <strong>{repo.repo}</strong>
        {repo.version ? <span className={styles.chip}>v{repo.version}</span> : null}
        {repo.latestTag ? <span className={styles.chip}>tag {repo.latestTag}</span> : null}
      </p>
      <p className={styles.rowMeta}>
        {repo.releaseWorkflow ? `workflow ${repo.releaseWorkflow}` : 'no release workflow found'}
        {repo.gh?.latestRelease ? ` · latest release ${repo.gh.latestRelease.tag}${repo.gh.latestRelease.prerelease ? ' (pre)' : ''}${repo.gh.latestRelease.draft ? ' (draft)' : ''}` : ''}
        {repo.gh?.latestRun ? ` · last run ${runLabel(repo.gh.latestRun)}${repo.gh.latestRun.at ? ` at ${repo.gh.latestRun.at}` : ''}` : ''}
        {repo.gh === null ? ' · GitHub status unavailable' : ''}
      </p>
      {repo.notes.map((note) => <p key={note} className={styles.rowMeta}>{note}</p>)}
    </div>
  );
}

export function OpsReleases() {
  const read = useQuery(opsReleasesQuery, { freshMs: 30_000 });
  const refetch = useRefetch(opsReleasesQuery);
  usePollWhileVisible(refetch, 60_000);
  const releases = read.data;

  return (
    <section className={styles.panel} aria-labelledby="ops-releases-title">
      <div className={styles.header}>
        <div>
          <h2 id="ops-releases-title">Releases</h2>
          <p>Where each enrolled repo's release stands: version, tag, workflow and the latest published result. Read-only.</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>
      {read.status === 'error' ? <p role="status">Release status is unavailable. Refresh to reconnect.</p>
        : !releases ? <p role="status">Reading releases…</p>
        : <>
            {releases.sourceState === 'degraded' ? <p role="status" className={styles.note}>The enrolled-repo list could not be read, so this may be incomplete.</p> : null}
            {releases.repos.length === 0
              ? <p className={styles.empty}>No enrolled repos to report on.</p>
              : <div className={styles.list}>{releases.repos.map((repo) => <RepoRow key={repo.path} repo={repo} />)}</div>}
          </>}
    </section>
  );
}
