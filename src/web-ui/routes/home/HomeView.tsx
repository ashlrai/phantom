/**
 * routes/home/HomeView.tsx — the daily home dashboard (GET /api/home, the same
 * report as `ashlr home --json` and MCP `ashlr_home`).
 */
import { Link } from 'react-router-dom';
import { homeDashboardQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { WelcomeCard } from './WelcomeCard.js';
import { ErrorState } from '../../components/states/States.js';
import styles from './HomeView.module.css';

const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className={styles.stat}><div className={styles.statValue}>{value}</div><div className={styles.statLabel}>{label}</div>{hint ? <div className={styles.hint}>{hint}</div> : null}</div>;
}

export function HomeView() {
  const q = useQuery(homeDashboardQuery);
  const d = q.data;
  if (!d) {
    return (
      <div className={styles.view}>
        <h1 className={styles.title}>Today</h1>
        {q.error
          ? <ErrorState what="The home dashboard" error={q.error} fix="ashlr home --json" />
          : <p className={styles.muted}>Loading today…</p>}
      </div>
    );
  }
  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Today</h1>
        <span className={styles.muted}>last {d.windowHours}h · {new Date(d.generatedAt).toLocaleTimeString()}</span>
      </header>
      <WelcomeCard />
      {d.empty ? (
        <section className={styles.empty}>
          <h2>Nothing shipped yet, and nothing needs you.</h2>
          <p>Turn on autonomy for the whole ecosystem, or hand Phantom a goal.</p>
          <p><Link to="/control/ecosystem" className={styles.cta}>Set up ecosystem autonomy</Link> <code>ashlr run "&lt;goal&gt;"</code></p>
        </section>
      ) : null}
      <section className={styles.stats} aria-label="Value">
        <Stat label="PRs merged" value={String(d.shipped.mergedPrs)} />
        <Stat label="spend" value={`$${d.spend.costUsd.toFixed(2)}`} hint={`${d.spend.tokens.toLocaleString()} tokens · ${d.spend.runs} runs`} />
        <Stat label="merges / $" value={d.value.mergesPerDollar === null ? '—' : String(d.value.mergesPerDollar)} hint={d.spend.costUsd === 0 ? 'subscription/local only' : undefined} />
        <Stat label="merges / 1M tokens" value={d.value.mergesPerMillionTokens === null ? '—' : String(d.value.mergesPerMillionTokens)} />
        <Stat label="agent time / merge" value={dur(d.value.secondsPerMerge)} />
        <Stat label="median open → merge" value={dur(d.value.medianOpenToMergeSeconds)} />
      </section>
      <div className={styles.columns}>
        <section aria-label="Needs you" className={styles.card}>
          <h2 className={styles.h2}>Needs you {d.needsYou.length ? `(${d.needsYou.length})` : ''}</h2>
          {d.needsYou.length === 0 ? <p className={styles.muted}>Nothing — agents are unblocked.</p> : (
            <ul className={styles.list}>{d.needsYou.map((a, i) => <li key={i}><div>{a.title}</div><code className={styles.cmd}>{a.command}</code></li>)}</ul>
          )}
        </section>
        <section aria-label="Running now" className={styles.card}>
          <h2 className={styles.h2}>Running now</h2>
          {d.runningNow.length === 0 ? <p className={styles.muted}>Nothing running. The steward schedule picks up red builds and labelled issues.</p> : (
            <ul className={styles.list}>{d.runningNow.map((r) => <li key={r.id}><Link to={`/work/runs/${r.id}`}>{r.goal}</Link> <span className={styles.muted}>{r.engine}</span></li>)}</ul>
          )}
        </section>
      </div>
      <section aria-label="Shipped" className={styles.card}>
        <h2 className={styles.h2}>Shipped</h2>
        {d.shipped.prs.length === 0 ? <p className={styles.muted}>No PRs merged in this window yet.</p> : (
          <ul className={styles.list}>{d.shipped.prs.map((p) => <li key={p.url}><a href={p.url} target="_blank" rel="noreferrer">{p.repo}#{p.number}</a> {p.title} <span className={styles.muted}>by {p.author}</span></li>)}</ul>
        )}
      </section>
      {d.warnings.map((w) => <p key={w} role="status" className={styles.warn}>{w}</p>)}
    </div>
  );
}
