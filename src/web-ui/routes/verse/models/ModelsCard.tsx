/**
 * routes/verse/models/ModelsCard.tsx: the Models card. Three counts (confirmed, stale,
 * unconfirmed) with every model the router can pick listed underneath, the ones that
 * need attention first. Built only on `GET /api/verse/fleet/control/models/check`,
 * the same report as `phm models check --json`. A stacked list, so it fits 390 px.
 */
import type { ModelCheckReport, ModelCheckState } from '../../../../core/fleet/model-check.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import styles from './models.module.css';

/** Another shape (an older server, a wrong route) is unreadable, not "all confirmed". */
export const modelCheckQuery: QueryDef<ModelCheckReport> = {
  key: 'verse-model-check',
  fetch: async signal => {
    const report = await apiGet<ModelCheckReport>('/api/verse/fleet/control/models/check', signal);
    if (!report || report.schema !== 'models.check.v1' || report.version !== 1 || !Array.isArray(report.models)) throw new Error('unexpected model check');
    return report;
  },
};

const STATES: ReadonlyArray<[ModelCheckState, string]> = [['unconfirmed', 'Unconfirmed'], ['stale', 'Stale'], ['confirmed', 'Confirmed']];
const COUNT_ORDER: readonly ModelCheckState[] = ['confirmed', 'stale', 'unconfirmed'];
const label = (state: ModelCheckState) => STATES.find(([key]) => key === state)![1];

export function ModelsCard({ visible = true }: { visible?: boolean }) {
  const result = useQuery(modelCheckQuery, { enabled: visible, freshMs: 60_000 });
  const report = result.data;
  return <Card title="Model check" caption="Confirmed means official docs named the model in the last 14 days.">
    {report === undefined ? <CardNote tone={result.status === 'error' ? 'unknown' : 'muted'}>
      {result.status === 'error' ? 'Model check is unknown: it could not be loaded.' : 'Counting models…'}
    </CardNote> : report.registry === 'unknown' ? <CardNote tone="unknown">Model check is unknown. {report.error}</CardNote> : <>
      <dl className={styles.counts} aria-label="Model counts">
        {COUNT_ORDER.map(state => <div key={state} data-state={state}><dd>{report.counts[state]}</dd><dt>{label(state)}</dt></div>)}
      </dl>
      {report.models.length === 0 ? <CardNote>No models are registered yet.</CardNote> : <ul className={styles.checkList} aria-label="Models the router can pick">
        {STATES.flatMap(([state]) => report.models.filter(row => row.state === state)).map(row => <li key={row.id} data-state={row.state}>
          <span className={styles.checkHead}><strong>{row.id}</strong><span data-state={row.state}>{label(row.state)}{row.routable ? '' : ' · not routable'}</span></span>
          <span className={styles.checkMeta}>
            {row.provider ?? 'Unknown provider'} · Lanes: {row.lanes.join(', ') || 'unknown'} · Confirmed: {row.confirmed_on ?? 'never'} · Source:{' '}
            {row.source_url?.startsWith('https://') ? <a href={row.source_url} target="_blank" rel="noreferrer">{new URL(row.source_url).hostname}</a> : 'none'}
          </span>
        </li>)}
      </ul>}
    </>}
  </Card>;
}
