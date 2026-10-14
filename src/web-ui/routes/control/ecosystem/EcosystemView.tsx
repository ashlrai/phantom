/**
 * routes/control/ecosystem/EcosystemView.tsx — `ashlr ecosystem status` per
 * repo, with one "Enable autonomy" button (POST /api/ecosystem/up). The button
 * clones, enrolls and turns the steward schedule on; the standing grant is
 * signed only in a terminal with Touch ID, so this page shows that command.
 */
import { useEffect, useState } from 'react';
import { ecosystemStatusQuery } from '../../../data/queries.js';
import { useQuery, useMutationHold } from '../../../data/hooks.js';
import { enableEcosystemAutonomy } from '../../../data/mutations.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import type { EcosystemReportV1, EcosystemStep } from '../../../../core/ecosystem/onboard.js';
import { ErrorState } from '../../../components/states/States.js';
import styles from './EcosystemView.module.css';

function yn(v: boolean | null): string {
  return v === null ? '?' : v ? 'yes' : 'no';
}

function stepClass(step: EcosystemStep): string {
  if (step.status === 'done' || step.status === 'already') return styles.ok ?? '';
  if (step.status === 'failed') return styles.bad ?? '';
  return styles.wait ?? '';
}

export function EcosystemView() {
  const query = useQuery(ecosystemStatusQuery);
  const hold = useMutationHold();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EcosystemReportV1 | null>(null);
  const report = result ?? query.data ?? null;

  async function run() {
    setBusy(true); setError(null);
    try { setResult(await enableEcosystemAutonomy()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setPending(false); }
  }
  function onEnable() {
    if (hold.hasHold) void run();
    else { setPending(true); setTokenOpen(true); }
  }
  useEffect(() => {
    if (tokenOpen || !pending) return;
    if (hold.hasHold) void run(); else setPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when the token dialog closes.
  }, [tokenOpen]);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Ecosystem</h1>
          <p className={styles.subtitle}>Let Phantom work autonomously across every Ashlr repo.</p>
        </div>
        <button type="button" className={styles.enable} disabled={busy || report?.ready === true} onClick={onEnable}>
          {report?.ready ? 'Autonomy on' : busy ? 'Enabling…' : 'Enable autonomy'}
        </button>
      </header>
      {error ? <p role="alert" className={styles.bad}>{error}</p> : null}
      {!report ? (query.error ? <ErrorState what="Ecosystem status" error={query.error} fix="ashlr ecosystem status" /> : <p>Loading…</p>) : (
        <>
          <ul className={styles.steps} aria-label="Onboarding steps">
            {report.steps.map((s) => (
              <li key={s.step} className={stepClass(s)}>
                <strong>{s.step}</strong> <span>{s.status}</span> — {s.detail}
                {s.command && s.status !== 'done' && s.status !== 'already' ? <pre className={styles.command}>{s.command}</pre> : null}
              </li>
            ))}
          </ul>
          <table className={styles.table}>
            <thead><tr><th>Repo</th><th>On disk</th><th>Enrolled</th><th>Auto-merge</th><th>CI gate</th><th>In grant</th></tr></thead>
            <tbody>
              {report.repos.map((r) => (
                <tr key={r.name} data-ok={r.ok}>
                  <td>{r.name}</td><td>{r.present}</td><td>{yn(r.enrolled)}</td><td>{yn(r.autoMerge)}</td>
                  <td>{r.requiredChecks === null ? '?' : r.verifyRequired ? 'ashlr/verify (remove)' : r.requiredChecks.length ? r.requiredChecks.join(', ') : 'none'}</td>
                  <td>{yn(r.inGrant)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.repos.some((r) => r.fixes.length) ? (
            <section aria-label="Fixes">
              <h2 className={styles.h2}>Fix</h2>
              {report.repos.flatMap((r) => r.fixes.map((f, i) => (
                <div key={`${r.name}-${i}`}><p>{r.name}: {f.why}</p><pre className={styles.command}>{f.command}</pre></div>
              )))}
            </section>
          ) : null}
          <section aria-label="Grant scope">
            <h2 className={styles.h2}>What the grant allows</h2>
            <ul>{report.grantScope.allowed.map((a) => <li key={a}>✓ {a}</li>)}</ul>
            <h2 className={styles.h2}>Always reserved for you</h2>
            <ul>{report.grantScope.reserved.map((a) => <li key={a}>✗ {a}</li>)}</ul>
          </section>
        </>
      )}
      <MutationTokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} reason="Enabling ecosystem autonomy requires the dispatch token." />
    </div>
  );
}
