/**
 * routes/verse/models/ModelsPane.tsx: the Models board. One group per provider, under its mark; one row per model
 * with the router's answer (routable or not, and why), the lanes and tiers that pick it, the last launch that used
 * it, when official docs last confirmed the name, and one action: "Verify" or "Check again"
 * (`phm models verify <id> --source <url>`; the server re-reads the doc page and its refusal is shown as written).
 *
 * Three reads, joined in models-board-model.ts: the registry (`phm models --json`), the check
 * (`phm models check --json`) and the lane model table (GET /api/verse/fleet/runs/lane-models). A read that fails
 * says so and its facts read "unknown"; the rows the other reads hold still draw.
 */
import { useState } from 'react';
import { providerFor } from '../../../../core/fleet/provider.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { laneModelsQuery } from '../fleet-capacity/lane-models-query.js';
import { boardGroups, boardModels, filterCounts, groupLine, lanesText, matchesFilter, modelsHeadline, type BoardModel, type ModelFilter } from './models-board-model.js';
import { modelCheckQuery, modelRegistryQuery, postVerifyModel } from './models-queries.js';
import styles from './models.module.css';

const FILTERS: readonly { value: ModelFilter; word: string; none: string }[] = [
  { value: 'all', word: 'All', none: '' },
  { value: 'attention', word: 'Needs attention', none: 'No model needs attention.' },
  { value: 'routable', word: 'Routable', none: 'No model is known to be routable.' },
];
const COUNTS = [['confirmed', 'Confirmed'], ['stale', 'Stale'], ['unconfirmed', 'Unconfirmed']] as const;

const docsLink = (url: string | null) => url?.startsWith('https://') ? <a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}</a> : 'none';
/** The provider's own name when the app knows the company, else the registry's word for it. */
function providerLabel(provider: string | null): string {
  if (provider === null) return 'Unknown provider';
  const known = providerFor(provider);
  return known.name === 'unknown' ? provider : known.name;
}
const ProviderMark = ({ provider }: { provider: string | null }) => <BrandMark brand={providerFor(provider).brand ?? provider} size={16} />;

type RowState = { busy: true } | { done: true } | { error: string };

/** `launches`: true when the launch log was read, so "no launch" is a fact and not a gap. */
function lastLaunchText(model: BoardModel, launches: boolean, nowMs: number): string | null {
  const launch = model.lastLaunch;
  if (launch) return `${launch.lane}${launch.tier ? ` ${launch.tier}` : ''}, ${launch.at === null ? 'time unknown' : formatRelative(launch.at, nowMs)}`;
  return launches ? 'not the latest on any lane' : null;
}

function ModelItem({ model, launches, nowMs, state, onVerify }: {
  model: BoardModel; launches: boolean; nowMs: number; state: RowState | undefined; onVerify: (source: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const recorded = model.sourceUrl?.startsWith('https://') ? model.sourceUrl : null;
  const source = recorded ?? typed.trim();
  const busy = state !== undefined && 'busy' in state;
  const facts: { label: string; value: React.ReactNode | null }[] = [
    { label: 'Lanes', value: lanesText(model) },
    { label: 'Last launch', value: lastLaunchText(model, launches, nowMs) },
    { label: 'Confirmed', value: model.confirmedOn?.slice(0, 10) ?? 'never' },
    { label: 'Source', value: docsLink(model.sourceUrl) },
    ...(model.replacement ? [{ label: 'Use instead', value: model.replacement }] : []),
  ];
  return <li className={styles.row} data-board-card data-tone={model.tone} aria-label={`${model.id} model`}>
    <div className={styles.head}>
      <strong>{model.id}</strong>
      {/* The words carry the state; the mark before them only repeats it. */}
      <span className={styles.state}>{model.state}</span>
    </div>
    {model.reason ? <p className={styles.reason}>{model.reason}</p> : null}
    <dl className={styles.facts}>{facts.map(fact => <div key={fact.label} className={styles.fact}>
      <dt>{fact.label}</dt>
      <dd data-unknown={fact.value === null || undefined}>{fact.value ?? 'unknown'}</dd>
    </div>)}</dl>
    {model.action === null ? null : <div className={styles.verify}>
      {recorded === null ? <input type="url" className={styles.url} placeholder="Official doc URL" aria-label={`Official doc URL for ${model.id}`}
        value={typed} onChange={event => setTyped(event.target.value)} /> : null}
      <button type="button" className={styles.action} disabled={busy || !source} onClick={() => onVerify(source)}
        aria-label={`${model.action === 'recheck' ? 'Check again' : 'Verify'}: ${model.id}`}>{model.action === 'recheck' ? 'Check again' : 'Verify'}</button>
      {state && 'done' in state ? <span className={styles.note} role="status">Confirmed by the docs today.</span> : null}
      {state && 'error' in state ? <span className={styles.bad} role="alert">{state.error}</span> : null}
    </div>}
  </li>;
}

export function ModelsPane({ visible = true }: { visible?: boolean }) {
  const [filter, setFilter] = useState<ModelFilter>('all');
  const [states, setStates] = useState<ReadonlyMap<string, RowState>>(new Map());
  const registryRead = useQuery(modelRegistryQuery, { enabled: visible, freshMs: 60_000 });
  const checkRead = useQuery(modelCheckQuery, { enabled: visible, freshMs: 60_000 });
  const lanesRead = useQuery(laneModelsQuery, { enabled: visible, freshMs: 30_000 });
  const refetchRegistry = useRefetch(modelRegistryQuery);
  const refetchCheck = useRefetch(modelCheckQuery);
  const set = (id: string, state: RowState) => setStates(prev => new Map(prev).set(id, state));
  const verify = (id: string, source: string) => {
    set(id, { busy: true });
    postVerifyModel(id, source).then(() => { set(id, { done: true }); refetchRegistry(); refetchCheck(); }, (err: unknown) => set(id, {
      error: err instanceof ApiError && err.detail ? err.detail : err instanceof Error ? err.message : 'Could not verify this model.',
    }));
  };

  const registry = registryRead.data?.entries ?? null;
  const report = checkRead.data ?? null;
  const check = report?.registry === 'ok' ? report : null;
  const lanes = lanesRead.data ?? null;
  const registryDown = registry === null && registryRead.status === 'error';
  const checkDown = report === null && checkRead.status === 'error';
  if (registry === null && report === null && !(registryDown && checkDown)) {
    return <p className={`${styles.root} ${styles.message}`} role="status">{registryDown ? 'Could not read the model registry, so its state is unknown.' : 'Checking models…'}</p>;
  }

  const models = boardModels({ registry, check, lanes });
  const counts = filterCounts(models);
  const groups = boardGroups(models.filter(model => matchesFilter(model, filter)));
  const launches = lanes?.source === 'ok' && lanes.launches !== null;
  const nowMs = Date.now();
  return <section className={styles.root} aria-label="Models">
    <p className={styles.headline}>{modelsHeadline(models.length, check)}</p>
    {registryDown ? <p className={styles.message} data-unknown role="status">Could not read the model registry, so its state is unknown.</p> : null}
    {checkDown ? <p className={styles.message} data-unknown role="status">Model check is unknown: it could not be loaded.</p> : null}
    {report && !check ? <p className={styles.message} data-unknown role="status">Model check is unknown. {report.error}</p> : null}
    {lanesRead.status === 'error' || lanes?.source === 'unavailable'
      ? <p className={styles.message} data-unknown role="status">{lanes?.reason ?? 'The lane model table could not be read'}, so which tier picks each model is unknown.</p> : null}
    {check ? <>
      <dl className={styles.counts} aria-label="Model counts">
        {COUNTS.map(([state, label]) => <div key={state} data-state={state}><dd data-zero={check.counts[state] === 0 || undefined}>{check.counts[state]}</dd><dt>{label}</dt></div>)}
      </dl>
      <p className={styles.meta}>Confirmed means official docs named the model in the last {check.stale_after_days} days.{check.docs_as_of ? ` Provider docs list as of ${check.docs_as_of.slice(0, 10)}.` : ''}</p>
    </> : null}
    {models.length === 0 ? (registryDown || (report !== null && !check) ? null
      : <p className={styles.message}>No models are registered yet. Add one with: phm models verify &lt;id&gt; --provider &lt;name&gt; --source &lt;official doc URL&gt;</p>) : <>
      <Segmented size="sm" aria-label="Show models" value={filter} onChange={setFilter}
        options={FILTERS.map(({ value, word }) => ({ value, label: `${word} ${counts[value]}` }))} />
      {groups.length === 0 ? <p className={styles.message} role="status">{FILTERS.find(item => item.value === filter)!.none}</p> : groups.map(group => {
        const name = providerLabel(group.provider);
        return <section key={group.provider ?? ''} className={styles.group} aria-label={`${name} models`}>
          <div className={styles.groupHead}><ProviderMark provider={group.provider} /><h3>{name}</h3><span>{groupLine(group)}</span></div>
          <ul className={styles.list}>{group.models.map(model => <ModelItem key={model.id} model={model} launches={launches} nowMs={nowMs}
            state={states.get(model.id)} onVerify={source => verify(model.id, source)} />)}</ul>
        </section>;
      })}
    </>}
    {check && check.missing.length > 0 ? <section className={styles.group} aria-label="Models missing from the registry">
      <div className={styles.groupHead}><h3>In provider docs, missing from the registry</h3></div>
      <ul className={styles.missing}>{check.missing.map(model => <li key={`${model.provider} ${model.id}`}>
        <ProviderMark provider={model.provider} /><strong>{model.id}</strong>
        <span>{providerLabel(model.provider)} · Seen: {model.seen_at.slice(0, 10)} · Source: {docsLink(model.source_url)}</span>
      </li>)}</ul>
    </section> : null}
    <p className={styles.message}>Same data: <code>phm models</code> and <code>phm models check</code>.</p>
  </section>;
}
