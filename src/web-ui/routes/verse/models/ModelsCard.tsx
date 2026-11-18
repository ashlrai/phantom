/**
 * routes/verse/models/ModelsCard.tsx: the Models card. The top line in plain words, three
 * counts (confirmed, stale, unconfirmed), every model the router can pick with the ones that
 * need attention first, then the models provider docs name that the registry lacks. Built only on `GET /api/verse/fleet/control/models/check`,
 * the same report as `phm models check --json`. A stacked list, so it fits 390 px.
 */
import type { ModelCheckReport, ModelCheckRow, ModelCheckState } from '../../../../core/fleet/model-check.js';
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
    if (!report || report.schema !== 'models.check.v1' || report.version !== 1 || !Array.isArray(report.models) || !Array.isArray(report.missing)) throw new Error('unexpected model check');
    return report;
  },
};

const LABELS: Record<ModelCheckState, string> = { confirmed: 'Confirmed', stale: 'Stale', unconfirmed: 'Unconfirmed' };
const COUNT_ORDER: readonly ModelCheckState[] = ['confirmed', 'stale', 'unconfirmed'];
/** What provider docs say, when it changes what to do. */
const DOCS_LABELS: Partial<Record<ModelCheckRow['docs'], string>> = { retired: 'Retired in docs', unconfirmed: 'Not in docs', deprecated: 'Deprecated in docs' };
/** Not routable first, then deprecated, then stale, then the rest; by id inside each group. */
const rank = (row: ModelCheckRow) => !row.routable ? 0 : row.docs === 'deprecated' ? 1 : row.state === 'stale' ? 2 : 3;
const sortRows = (rows: readonly ModelCheckRow[]) => [...rows].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const docsLink = (url: string | null) => url?.startsWith('https://') ? <a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}</a> : 'none';

export function ModelsCard({ visible = true }: { visible?: boolean }) {
  const result = useQuery(modelCheckQuery, { enabled: visible, freshMs: 60_000 });
  const report = result.data;
  return <Card title="Model check" caption="Confirmed means official docs named the model in the last 14 days.">
    {report === undefined ? <CardNote tone={result.status === 'error' ? 'unknown' : 'muted'}>
      {result.status === 'error' ? 'Model check is unknown: it could not be loaded.' : 'Counting models…'}
    </CardNote> : report.registry === 'unknown' ? <CardNote tone="unknown">Model check is unknown. {report.error}</CardNote> : <>
      <p className={styles.summary}>{report.summary}</p>
      <dl className={styles.counts} aria-label="Model counts">
        {COUNT_ORDER.map(state => <div key={state} data-state={state}><dd>{report.counts[state]}</dd><dt>{LABELS[state]}</dt></div>)}
      </dl>
      {report.models.length === 0 ? <CardNote>No models are registered yet.</CardNote> : <ul className={styles.checkList} aria-label="Models the router can pick">
        {sortRows(report.models).map(row => <li key={row.id} data-state={row.state}>
          <span className={styles.checkHead}><strong>{row.id}</strong><span data-state={row.routable ? row.state : 'unconfirmed'}>{DOCS_LABELS[row.docs] ?? LABELS[row.state]}{row.routable ? '' : ' · not routable'}</span></span>
          <span className={styles.checkMeta}>
            {row.provider ?? 'Unknown provider'} · Lanes: {row.lanes.join(', ') || 'unknown'} · Confirmed: {row.confirmed_on ?? 'never'} · Source: {docsLink(row.source_url)}
            {row.replacement ? ` · Use: ${row.replacement}` : ''}
          </span>
        </li>)}
      </ul>}
      {report.missing.length > 0 && <ul className={styles.checkList} aria-label="Models missing from the registry">
        {report.missing.map(model => <li key={`${model.provider} ${model.id}`}>
          <span className={styles.checkHead}><strong>{model.id}</strong><span>Missing from the registry</span></span>
          <span className={styles.checkMeta}>{model.provider} · Seen: {model.seen_at.slice(0, 10)} · Source: {docsLink(model.source_url)}</span>
        </li>)}
      </ul>}
    </>}
  </Card>;
}
