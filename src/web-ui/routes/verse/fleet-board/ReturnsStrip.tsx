import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { returnsQuery } from './returns-query.js';
import { returnsHeadline, type ParsedReturns } from './returns-model.js';
import styles from './fleet-board.module.css';

function age(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function ReturnsBody({ parsed, now }: { parsed: ParsedReturns | null; now: number }) {
  const headline = parsed === null ? null : returnsHeadline(parsed);
  return (
    <>
      <p className={headline?.tone === 'danger' ? styles.error : styles.orderNote}>
        {headline?.text ?? 'The results API has not landed in this build yet.'}
      </p>
      {parsed?.state === 'known' ? (
        <ul className={styles.orderRows}>
          {parsed.rows.slice(0, 8).map((row, i) => (
            <li className={styles.orderRow} key={`${row.claimId}|${row.at}|${i}`}>
              <span className={styles.orderState} data-state={row.result}>{row.result}</span>
              <span>{row.repo}</span>
              <span className={styles.mono}>{row.evidenceKind === 'pr'
                ? `PR #${row.pr} · head ${row.head?.slice(0, 7)}` : row.evidenceKind}</span>
              <span>{row.from}</span>
              <span title={row.at}>{age(row.at, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {parsed && parsed.dropped + parsed.unparsed > 0 ? (
        <p className={styles.orderNote}>{parsed.dropped} malformed rows dropped · {parsed.unparsed} receipts unparsed</p>
      ) : null}
      <p className={styles.orderNote}>VERIFIED is the returning agent's evidence; Phantom has not checked the PR.</p>
    </>
  );
}

export function ReturnsStrip({ visible = true }: { visible?: boolean }) {
  const read = useQuery(returnsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(returnsQuery);
  usePollWhileVisible(() => { refetch(); }, 30_000, { enabled: visible });
  return (
    <section className={styles.orderStrip} aria-label="Results">
      <h3 className={styles.sectionTitle}>Results</h3>
      {read.data !== undefined ? <ReturnsBody parsed={read.data} now={Date.now()} />
        : <p className={styles.orderNote}>{read.status === 'error' ? 'Results unknown: request failed' : 'Loading results…'}</p>}
    </section>
  );
}
