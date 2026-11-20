/**
 * The Supply card, on desktop Command (beside the Leader card) and the phone's Home: is the fleet feeding
 * itself? One plain verdict line first, jobs landed in 24 h from the Leader, Core and the gap hook, the top
 * reject reason, and how long ago the last self-supplied job landed. Built only on the typed
 * doctor.supply.v1 report (`phm doctor supply --json`) through supplyCardModel; never parses CLI text.
 * A fact the Mac could not read says unknown and names the path. Read-only.
 */
import type { SupplyDoctorReport } from '../../../../core/fleet/supply-doctor.js';
import { asSupplyReport, supplyCardModel } from '../../../../core/fleet/supply-card.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const SUPPLY_PATH = '/api/verse/supply';
export const supplyQuery: QueryDef<SupplyDoctorReport | null> = {
  key: 'supply-doctor',
  fetch: async signal => asSupplyReport(await apiGet<unknown>(SUPPLY_PATH, signal)),
};

/** The card's body, pure on the report so a test renders it from a fixture. */
export function SupplyBody({ report, error }: { report: SupplyDoctorReport | null; error?: string | null }) {
  if (!report) {
    return <p data-unknown role="status">Self-supply is unknown: {error ?? 'this Mac’s build does not report it yet. Update Phantom on your Mac.'}</p>;
  }
  const m = supplyCardModel(report);
  return <>
    <p data-tone={m.tone} role="status"><strong>{m.verdict}</strong></p>
    {m.sourcesNote ? <p data-unknown>{m.sourcesNote}</p> : <ul aria-label="Jobs landed in 24 hours">
      {m.sources.map(s => <li key={s.label}>{s.label}: {s.count} in 24 h</li>)}
    </ul>}
    <p>{m.rejects}</p>
    <p>{m.lastLanded}</p>
    <p>Every number: <code className={styles.command}>{m.command}</code></p>
  </>;
}

function useSupply(visible: boolean) {
  const read = useQuery(supplyQuery, { enabled: visible });
  const refresh = useRefetch(supplyQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = read.data ?? null;
  const failed = Boolean(read.error) || read.status === 'error';
  return { report, loading: !report && !failed && (read.status === 'loading' || read.status === 'idle'), error: failed && !report ? 'the Mac did not answer. Try again.' : null };
}

/** Desktop Command: same Card as the Leader card, so the two sit side by side. */
export function SupplyCard({ visible = true }: { visible?: boolean }) {
  const { report, loading, error } = useSupply(visible);
  return <Card title="Supply">
    {loading ? <p aria-busy="true">Reading self-supply…</p> : <SupplyBody report={report} error={error} />}
  </Card>;
}

/** Phone Home: the same body in the Home card frame. */
export function SupplyCardPhone({ visible = true }: { visible?: boolean }) {
  const { report, loading, error } = useSupply(visible);
  return <section className={styles.card} aria-label="Supply">
    <h3>Supply</h3>
    {loading ? <p aria-busy="true">Reading self-supply…</p> : <SupplyBody report={report} error={error} />}
  </section>;
}
