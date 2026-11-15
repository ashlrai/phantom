/**
 * routes/verse/fleet-board/CoordAnswerStrip.tsx — the compact "Coordination
 * answer" strip at the top of the Fleet Board pane (RQ-PHX-COORDANSWERSTRIP322):
 * Mason/Dot's Nov13 13:13 ET order as one REACHABLE / BLOCKED line with the
 * reasons in plain words. Reuses the existing query defs
 * (runtime-identity, comms-status channel health, work board) plus the advisory claims ledger so the shared
 * cache still serves one request each; polls at 15 s while visible. Read-only.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { channelHealthQuery } from '../fleet-channels/channel-health-query.js';
import { narrowChannelHealth, type ChannelHealthView } from '../fleet-channels/channel-health-model.js';
import { runtimeIdentityQuery } from '../fleet-host/runtime-identity-query.js';
import type { RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import { deriveCoordAnswer, type CoordBoardView } from './coord-answer-model.js';
import { coordinationClaimsQuery, type CoordLedgerView } from './coordination-claims-query.js';
import { deriveRecheckLine, recheckVerdictQuery } from './recheck-verdict-query.js';
import { workBoardQuery } from './work-board-section.js';
import styles from './fleet-board.module.css';

export function CoordAnswerStrip({ visible }: { visible: boolean }) {
  const runtime = useQuery(runtimeIdentityQuery, { enabled: visible, freshMs: 0 });
  const channels = useQuery(channelHealthQuery, { enabled: visible, freshMs: 0 });
  const board = useQuery(workBoardQuery, { enabled: visible, freshMs: 0 });
  const ledger = useQuery(coordinationClaimsQuery, { enabled: visible, freshMs: 0 });
  const recheck = useQuery(recheckVerdictQuery, { enabled: visible, freshMs: 0 });
  const refetchRuntime = useRefetch(runtimeIdentityQuery);
  const refetchChannels = useRefetch(channelHealthQuery);
  const refetchBoard = useRefetch(workBoardQuery);
  const refetchLedger = useRefetch(coordinationClaimsQuery);
  const refetchRecheck = useRefetch(recheckVerdictQuery);
  usePollWhileVisible(() => { refetchRuntime(); refetchChannels(); refetchBoard(); refetchLedger(); refetchRecheck(); }, 15_000, { enabled: visible });

  // undefined = the read has not settled; null/{available:false} = settled as
  // unavailable (missing route or failed read) — never conflated with loading.
  const runtimeView: RuntimeIdentityView | null | undefined =
    runtime.data === undefined && runtime.status === 'error' ? null : runtime.data;
  const channelsView: ChannelHealthView | undefined =
    channels.data !== undefined ? narrowChannelHealth(channels.data)
      : channels.status === 'error' ? { available: false } : undefined;
  const boardView: CoordBoardView | null | undefined =
    board.data === undefined && board.status === 'error' ? null : board.data;

  // A failed (non-404) ledger read is shown as unreadable, not as loading.
  const ledgerView: CoordLedgerView | null | undefined =
    ledger.data === undefined && ledger.status === 'error'
      ? { state: 'unknown', generatedAt: null, claims: [], expiredClaims: null } : ledger.data;

  const answer = deriveCoordAnswer({ runtime: runtimeView, channels: channelsView, board: boardView, ledger: ledgerView, now: Date.now() });

  // Additional server evidence only; never feeds deriveCoordAnswer's verdict.
  const recheckLine = deriveRecheckLine(
    recheck.data === undefined && recheck.status === 'error' ? 'error' : recheck.data, Date.now());

  return (
    <section className={styles.coordAnswer} aria-labelledby="fb-coord-answer" data-verdict={answer.verdict}>
      <div className={styles.coordHead}>
        <h3 id="fb-coord-answer" className={styles.sectionTitle}>Coordination answer</h3>
        <span className={styles.coordVerdict} data-verdict={answer.verdict}>{answer.verdict}</span>
      </div>
      <dl className={styles.coordRows}>
        {answer.rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd data-ok={String(row.ok)}>{row.value}</dd>
          </div>
        ))}
        <div>
          <dt>Server</dt>
          <dd data-ok={String(recheckLine.ok)}>{recheckLine.text}</dd>
        </div>
      </dl>
      {answer.missing.length > 0 ? (
        <ul className={styles.coordMissing}>
          {answer.missing.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
