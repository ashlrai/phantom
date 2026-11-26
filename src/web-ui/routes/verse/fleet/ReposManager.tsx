import { useEffect, useState } from 'react';
import type { listManagedRepos } from '../../../../core/fleet/repos-manager.js';
import type { RepoPriority } from '../../../../core/fleet/repo-market.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { Button } from '../../../components/primitives/Button.js';
import type { GrantFlow } from '../command/AutonomyBar.js';
import styles from './ReposManager.module.css';

type Repos = Awaited<ReturnType<typeof listManagedRepos>>;
const display = (value: string | number | null) => value === null ? 'Unknown' : value;

export function ReposManager({ grantFlow, readOnly }: { grantFlow: GrantFlow; readOnly: boolean }) {
  const [data, setData] = useState<Repos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiGet<Repos>('/api/repos', controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Repository data could not be loaded.');
    });
    return () => controller.abort();
  }, [revision]);

  async function setPriority(repo: string, priority: RepoPriority) {
    const token = getMutationToken();
    if (!token) { setError('Unlock changes before setting a priority.'); return; }
    setSaving(repo);
    setError(null);
    try {
      await apiPost('/api/repos/priority', { repo, priority }, token);
      touchMutationHold();
      setRevision(value => value + 1);
    } catch {
      setError('The priority could not be saved.');
    } finally {
      setSaving(null);
    }
  }

  return <section id="repos-manager" className={styles.card} aria-labelledby="repos-manager-title">
    <header className={styles.heading}>
      <div><div className={styles.eyebrow}>FLEET / WORK MARKET</div><h2 id="repos-manager-title">Repos manager</h2></div>
      <div className={styles.buttons}>
        {data?.prioritySync === 'local-only' ? <span className={styles.badge} title="Priority changes apply only on this Mac.">Not synced</span> : null}
        <Button size="sm" onClick={() => { setError(null); setRevision(value => value + 1); }}>Refresh</Button>
      </div>
    </header>
    <p className={styles.description}>Work is allocated by evidence, not repo order. Boost adds at most 25% to a scheduling score; pause stops new queue claims without changing the signed grant.</p>
    {error ? <p role="status">{error}</p> : !data ? <p role="status">Reading repository evidence…</p> : null}
    {data?.enrollmentStatus === 'degraded' ? <p role="status">Enrollment data is unavailable. Authority has not changed.</p> : null}
    {data?.canManageGrant === false ? <p className={styles.description}>Review signed grant changes on the leader.</p> : null}
    {data ? <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr><th>Repository</th><th>Enrollment / grant</th><th>Ready</th><th>Merges / day</th><th>Open PRs</th><th>CI</th><th>Last release</th><th>Allocation</th><th>Priority / scope</th></tr></thead>
        <tbody>{data.repos.map(row => <tr key={row.repo}>
          <th scope="row"><div className={styles.repo}>
            {row.logo ? <img className={styles.logo} alt="" src={`${import.meta.env.BASE_URL}logos/${row.logo}`} /> : <span className={styles.logo} aria-hidden="true">{row.label.slice(0, 2).toUpperCase()}</span>}
            <div><span>{row.label}</span><small>{row.repo}</small></div>
          </div></th>
          <td>{row.enrolled === null ? 'Unknown' : row.enrolled ? 'Enrolled' : 'Not enrolled'}<small>{row.grantStage ?? 'No active rung'}</small></td>
          <td>{display(row.queueDepth)}</td><td>{display(row.mergesPerDay)}</td><td>{display(row.openPrs)}</td>
          <td><span className={styles.ci} data-ci={row.ciHealth ?? 'unknown'}>{display(row.ciHealth)}</span></td>
          <td>{row.lastRelease ? <>{row.lastRelease.tag}<small><time dateTime={row.lastRelease.publishedAt}>{row.lastRelease.publishedAt.slice(0, 10)}</time></small></> : 'Unknown'}</td>
          <td className={styles.allocation}>
            <strong>{(row.allocation.share * 100).toFixed(1)}%</strong><small>{row.allocation.source === 'queue' ? 'Queue target' : 'Estimate'}</small>
            <details><summary>Why</summary><ul>{row.allocation.reasonCodes.map(reason => <li key={reason}><code>{reason}</code></li>)}</ul></details>
          </td>
          <td><select aria-label={`Priority for ${row.label}`} value={row.priority} disabled={readOnly || saving !== null}
            onChange={event => void setPriority(row.repo, event.target.value as RepoPriority)}>
            <option value="normal">Normal</option><option value="boost">Boost</option><option value="pause">Pause</option>
          </select>
          <div className={styles.buttons}>
            {row.enrolled === false ? <Button size="sm" disabled={readOnly || !data.canManageGrant} onClick={() => grantFlow.open('grant',
              `Review enrolling ${row.repo}. If its checkout is not ready, first prepare and enroll it. Only the signed grant enables standing authority.`, null,
              { repoChange: { repo: row.repo, intent: 'add' } })}>Enroll</Button> : null}
            {row.enrolled || row.grantStage ? <Button size="sm" disabled={readOnly || !data.canManageGrant} onClick={() => grantFlow.open('grant',
              `Review removing ${row.repo} from standing authority with Touch ID.`, null,
              { repoChange: { repo: row.repo, intent: 'remove' } })}>Remove</Button> : null}
            {row.enrolled || row.grantStage ? <Button size="sm" disabled={readOnly || !data.canManageGrant} onClick={() => grantFlow.open('grant',
              `Review the signed propose/merge ladder for ${row.repo}. Approval requires Touch ID.`, null,
              { repoChange: { repo: row.repo, intent: row.grantStage === 'merge' ? 'propose' : 'merge' } })}>
              {row.grantStage === 'merge' ? 'Propose only' : 'Review merge'}
            </Button> : null}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : null}
  </section>;
}
