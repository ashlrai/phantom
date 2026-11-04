import type { BuildIdentity } from '../../../../core/build-identity.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './MobileShell.module.css';

const versionQuery: QueryDef<BuildIdentity> = {
  key: 'verse-running-version',
  fetch: (signal) => apiGet<BuildIdentity>('/api/verse/version', signal),
};

/** Report the running Hub, including explicit unknowns for unpackaged dev builds. */
export function BuildFooter() {
  const { data } = useQuery(versionQuery);
  const refetch = useRefetch(versionQuery);
  usePollWhileVisible(refetch, 60_000);
  return (
    <footer className={styles.build} aria-label="Running app version">
      Phantom {data?.packageVersion ?? 'version unavailable'}
      {' · master '}<span title={data?.revision ?? undefined}>{data?.revision?.slice(0, 12) ?? 'sha unavailable'}</span>
      {data?.dirty ? ' (modified)' : ''}
    </footer>
  );
}
