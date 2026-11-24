/**
 * Home's Pulse card, first on the desktop and the phone: is the fleet doing well right now, as five numbers with a
 * trend arrow against the day before and one plain line each. Built only on `phm fleet pulse --json` (fleet.pulse.v1).
 * Read-only. An unknown number reads "unknown", never 0. A last "Running build" row reads `phm self drift --json`
 * (phantom.self-drift.v1): is the installed CLI behind, and which fleet features are not live in it yet (tap to list).
 */
import type { ReactNode } from 'react';
import type { PulseNumber, PulseV1 } from '../../../../core/fleet/pulse.js';
import { narrowSelfDrift, type SelfDriftV1 } from '../../../../core/release/drift-shape.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const PULSE_PATH = '/api/verse/fleet/runs/pulse';
export const pulseQuery: QueryDef<PulseV1> = { key: 'fleet-pulse', fetch: signal => apiGet(PULSE_PATH, signal) };
export const DRIFT_PATH = '/api/verse/fleet/runs/drift';
export const driftQuery: QueryDef<SelfDriftV1> = { key: 'self-drift', fetch: signal => apiGet(DRIFT_PATH, signal) };

const ARROW = { up: '↑', down: '↓', flat: '→', unknown: '?' } as const;
const minutes = (s: number) => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`;

/** Only a well-formed fleet.pulse.v1 payload is a pulse. */
function pulseOf(data: unknown): PulseV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const pulse = data as Partial<PulseV1>;
  return pulse.schema === 'fleet.pulse.v1' && pulse.v === 1 && !!pulse.mergesPerHour && !!pulse.poolsOnPace ? pulse as PulseV1 : null;
}

/** 24 hourly merge counts as one line; the first point is 24 hours ago. */
export function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 96 + 2},${22 - (v / max) * 20}`).join(' ');
  return <svg className={styles.spark} viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label={`Merged per hour over 24 hours: ${values.join(', ')}`}>
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function Row({ title, field, value, children }: { title: string; field: PulseNumber; value: (v: number) => string; children?: ReactNode }) {
  const tone = field.better === null ? undefined : field.better ? 'better' : 'worse';
  const said = field.trend === 'unknown' ? 'trend unknown' : `${field.trend === 'flat' ? 'flat' : field.trend}${tone ? `, ${tone}` : ''} since yesterday`;
  return <li className={styles.pulseRow} aria-label={title}>
    <span className={styles.pulseTitle}>{title}</span>
    <span className={styles.pulseValue}>{field.value === null ? <span data-unknown>unknown</span> : value(field.value)}{' '}
      <span className={styles.arrow} data-tone={tone} role="img" aria-label={said}>{ARROW[field.trend]}</span></span>
    {children}
    <span className={styles.pulseLine} data-unknown={field.value === null || undefined}>{field.line}</span>
  </li>;
}

/** Up to date, or how far behind with the not-live fleet features one tap away. Hidden for an older server. */
function RunningBuild({ visible }: { visible: boolean }) {
  const read = useQuery(driftQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(driftQuery);
  usePollWhileVisible(refresh, 600_000, { enabled: visible });
  const drift = narrowSelfDrift(read.data);
  if (!drift && read.status !== 'error') return null;
  const version = drift?.installed.version ?? 'unknown';
  const listed = drift ? [...drift.missingFeatures.map(name => `${name}: not live yet`), ...drift.unknownFeatures.map(name => `${name}: unknown`)] : [];
  return <li className={styles.pulseRow} aria-label="Running build">
    <span className={styles.pulseTitle}>Running build</span>
    <span className={styles.pulseValue}>{version === 'unknown' ? <span data-unknown>unknown</span> : version}</span>
    {!drift ? <span className={styles.pulseLine} data-unknown>Unknown: the running build could not be read.</span>
      : listed.length ? <details className={styles.pulseLine}><summary>{drift.line}</summary><ul>{listed.map(text => <li key={text}>{text}</li>)}</ul></details>
        : <span className={styles.pulseLine}>{drift.line}</span>}
  </li>;
}

export function PulseCard({ visible = true }: { visible?: boolean }) {
  const read = useQuery(pulseQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(pulseQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const pulse = pulseOf(read.data);
  if (!pulse) {
    // Before the first read, or any other payload (an older server), the card stays hidden.
    if (read.status !== 'error') return null;
    return <section className={styles.card} aria-label="Pulse"><h3>Pulse</h3><p data-unknown>Unknown: the pulse could not be read.</p></section>;
  }
  const { mergesPerHour: m, medianMergeSeconds: t, mainsGreen: g, daysSinceRelease: r, poolsOnPace: p } = pulse;
  return <section className={styles.card} aria-label="Pulse">
    <h3>Pulse</h3>
    <p className={styles.headline} data-health={pulse.verdict === 'bad' ? 'red' : pulse.verdict === 'watch' ? 'stalled' : undefined}>{pulse.headline}</p>
    <ul className={styles.pulse}>
      <Row title="PRs merged per hour" field={m} value={String}><Sparkline values={m.sparkline} /></Row>
      <Row title="Median publish to merge" field={t} value={minutes} />
      <Row title="Main branches green" field={g} value={v => `${v} of ${g.total}`} />
      <Row title="Days since last release" field={r} value={String} />
      <Row title="Pools on pace" field={p} value={v => `${v} of ${p.measured}`} />
      <RunningBuild visible={visible} />
    </ul>
  </section>;
}
