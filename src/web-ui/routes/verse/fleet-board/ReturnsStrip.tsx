import { RelativeTime } from '../../../components/primitives/RelativeTime.js';
import { useEffect, useReducer, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { returnsQuery } from './returns-query.js';
import { returnsHeadline, returnTemporal, type ParsedReturns } from './returns-model.js';
import { parseVerify, verdictFor, verdictLabel, verifyHeadline, type ParsedVerify, type VerifyChecked } from './returns-verify-model.js';
import styles from './fleet-board.module.css';

/** GitHub's second read: fetched once per click, never polled. */
export type VerifyState = { status: 'idle' | 'loading' | 'error' } | { status: 'done'; parsed: ParsedVerify };

/** Reuses the receipt chip colours: only merged-at-head is green; open and unknown stay neutral. */
function chipState(checked: VerifyChecked | null): string | undefined {
  if (checked?.verdict === 'merged-at-head') return 'VERIFIED';
  return checked?.verdict === 'merged-other-head' || checked?.verdict === 'closed-unmerged' ? 'BLOCKED' : undefined;
}

export function ReturnsBody({ parsed, now, verify = { status: 'idle' }, onVerify }: {
  parsed: ParsedReturns | null; now: number; verify?: VerifyState; onVerify?: () => void;
}) {
  const headline = parsed === null ? null : returnsHeadline(parsed, now);
  const github = verify.status === 'done' ? verify.parsed : null;
  const githubHeadline = github === null ? null : verifyHeadline(github);
  return (
    <>
      <p className={headline?.tone === 'danger' ? styles.error : styles.orderNote}>
        {headline?.text ?? 'The results API has not landed in this build yet.'}
      </p>
      {parsed?.state === 'known' ? (
        <ul className={styles.orderRows}>
          {parsed.rows.slice(0, 8).map((row, i) => {
            const checked = github === null ? null : verdictFor(github, row);
            return (
            <li className={styles.orderRow} key={`${row.claimId}|${row.at}|${i}`}>
              <span className={styles.orderState} data-state={returnTemporal(row, now) === 'current' ? row.result : 'background'}>
                {row.result} · {returnTemporal(row, now)}{returnTemporal(row, now) === 'current' ? '' : ' (background)'}
              </span>
              <span>{row.repo}</span>
              <span className={styles.mono}>{row.evidenceKind === 'pr'
                ? `PR #${row.pr} · head ${row.head?.slice(0, 7)}` : row.evidenceKind}</span>
              {github !== null && row.result === 'VERIFIED' && row.evidenceKind === 'pr' ? (
                <span className={styles.orderState} data-state={chipState(checked)}>
                  {checked === null ? 'not checked' : verdictLabel(checked)}
                </span>
              ) : null}
              <span>{row.from}</span>
              <RelativeTime value={row.at} now={now} />
            </li>
            );
          })}
        </ul>
      ) : null}
      {parsed && parsed.dropped + parsed.unparsed > 0 ? (
        <p className={styles.orderNote}>{parsed.dropped} malformed rows dropped · {parsed.unparsed} receipts unparsed</p>
      ) : null}
      {github !== null && githubHeadline !== null ? (
        <p className={githubHeadline.tone === 'danger' ? styles.error : styles.orderNote}>
          {githubHeadline.text} <RelativeTime value={github.asOf} now={now} prefix="· as of " />
        </p>
      ) : (
        <p className={styles.orderNote}>VERIFIED is the returning agent's evidence; Phantom has not checked the PR.</p>
      )}
      {verify.status === 'error' ? <p className={styles.error}>GitHub check unavailable</p> : null}
      {onVerify && parsed?.state === 'known' ? (
        <button type="button" onClick={onVerify} disabled={verify.status === 'loading'}>
          {verify.status === 'loading' ? 'Checking GitHub…' : 'Check on GitHub'}
        </button>
      ) : null}
    </>
  );
}

export function ReturnsStrip({ visible = true }: { visible?: boolean }) {
  const read = useQuery(returnsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(returnsQuery);
  const [, tick] = useReducer(value => value + 1, 0);
  const now = Date.now();
  useEffect(() => {
    if (!visible) return;
    const boundaries = read.data?.rows.flatMap(row => [Date.parse(row.at), Date.parse(row.expiresAt)]) ?? [];
    const next = Math.min(...boundaries.filter(at => at > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(tick, Math.min(next - now, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [read.data, visible, now]);
  usePollWhileVisible(() => { refetch(); }, 30_000, { enabled: visible });
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' });
  const onVerify = () => {
    setVerify({ status: 'loading' });
    apiGet<unknown>('/api/verse/fleet/coordination-claims/returns/verify').then(parseVerify).then(
      parsed => setVerify(parsed === null ? { status: 'error' } : { status: 'done', parsed }),
      () => setVerify({ status: 'error' }),
    );
  };
  return (
    <section className={styles.orderStrip} aria-label="Results">
      <h3 className={styles.sectionTitle}>Results</h3>
      {read.data !== undefined ? <ReturnsBody parsed={read.data} now={now} verify={verify} onVerify={onVerify} />
        : <p className={styles.orderNote}>{read.status === 'error' ? 'Results unknown: request failed' : 'Loading results…'}</p>}
    </section>
  );
}
