/**
 * routes/verse/usage/UsageResourcesPanel.tsx — the "Every resource" grid
 * (RQ-NIGHT-USAGE-1): all twelve operator resources, one row each, fed by
 * GET /api/verse/usage-resources.
 *
 * Rendering rules, same bar as the account windows: a measured row gets a
 * real meter; a resource with no reader says "No reader yet" with a dashed
 * rule — never a bar, never a number. Unreadable reads say so in words.
 */
import type { ReactNode } from 'react';
import { useQuery } from '../../../data/hooks.js';
import sectionStyles from './usage.module.css';
import styles from './usage-resources.module.css';
import { narrowUsageResources, resourceRows, type ResourceRowView } from './usage-resources-model.js';
import { usageResourcesQuery } from './usage-queries.js';

function meterTone(percent: number | null): string | undefined {
  if (percent === null) return undefined;
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return undefined;
}

function ResourceCell({ view }: { view: ResourceRowView }): ReactNode {
  return (
    <li className={styles.cell} data-state={view.state} data-resource={view.id}>
      <div className={styles.cellHead}>
        <span className={styles.cellName}>{view.label}</span>
        {view.stateText ? <span className={styles.cellState}>{view.stateText}</span> : null}
      </div>

      {view.state === 'ok' ? (
        <>
          <p className={styles.amount}>{view.amountText ?? '—'}</p>
          {view.percent !== null ? (
            <div
              className={styles.track}
              data-tone={meterTone(view.percent)}
              role="meter"
              aria-label={`${view.label} used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(view.percent)}
              aria-valuetext={view.amountText ?? undefined}
            >
              <div className={styles.fill} style={{ width: `${Math.round(view.percent)}%` }} />
            </div>
          ) : (
            <hr className={styles.unknownRule} aria-hidden="true" />
          )}
          <dl className={styles.meta}>
            <div className={styles.metaRow}>
              <dt className={styles.metaKey}>resets</dt>
              <dd className={styles.metaValue}>{view.resetText}</dd>
            </div>
            <div className={styles.metaRow}>
              <dt className={styles.metaKey}>source</dt>
              <dd className={styles.metaValue}>{view.sourceText}</dd>
            </div>
            {view.asOfText ? (
              <div className={styles.metaRow}>
                <dt className={styles.metaKey}>as of</dt>
                <dd className={styles.metaValue}>{view.asOfText}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <>
          <hr className={styles.unknownRule} aria-hidden="true" />
          <dl className={styles.meta}>
            {view.sourceText ? (
              <div className={styles.metaRow}>
                <dt className={styles.metaKey}>{view.state === 'unavailable' ? 'reason' : 'source'}</dt>
                <dd className={styles.metaValue}>{view.sourceText}</dd>
              </div>
            ) : null}
          </dl>
        </>
      )}
    </li>
  );
}

export function UsageResourcesPanel(): ReactNode {
  const read = useQuery(usageResourcesQuery);
  const wire = narrowUsageResources(read.data?.available ? read.data.raw : null);
  const rows = resourceRows(wire);

  const unavailableReason =
    read.data && !read.data.available
      ? read.data.reason
      : read.data?.available && !wire
        ? 'The usage resources payload did not match its contract.'
        : null;

  return (
    <section className={sectionStyles.panel} aria-labelledby="verse-usage-resources">
      <div className={sectionStyles.panelHead}>
        <h3 id="verse-usage-resources" className={sectionStyles.panelTitle}>
          Every resource
        </h3>
      </div>
      {read.status === 'loading' || read.status === 'idle' ? (
        <p className={sectionStyles.panelNote}>Reading every resource…</p>
      ) : read.status === 'error' ? (
        <p className={sectionStyles.panelNote} role="alert">
          Usage resources unavailable{read.error?.message ? ` — ${read.error.message}` : ''}
        </p>
      ) : unavailableReason ? (
        <p className={sectionStyles.panelNote}>{unavailableReason}</p>
      ) : (
        <ul className={styles.grid}>
          {rows.map((view) => <ResourceCell key={view.id} view={view} />)}
        </ul>
      )}
    </section>
  );
}
