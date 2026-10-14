/**
 * routes/settings/SettingsView.tsx — autonomy, repos, schedules, models,
 * budget caps, notifications and the versioned constitution. Every control
 * posts one {key, value} to /api/settings, the same change `ashlr settings
 * set` and MCP `ashlr_settings_set` make.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { settingsQuery } from '../../data/queries.js';
import { useQuery, useMutationHold } from '../../data/hooks.js';
import { changeSetting } from '../../data/mutations.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ErrorState } from '../../components/states/States.js';
import styles from './SettingsView.module.css';

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return <section className={styles.section} aria-label={title}><h2 className={styles.h2}>{title}</h2>{hint ? <p className={styles.hint}>{hint}</p> : null}{children}</section>;
}

export function SettingsView() {
  const q = useQuery(settingsQuery);
  const hold = useMutationHold();
  const [pending, setPending] = useState<{ key: string; value: unknown } | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [budget, setBudget] = useState('');

  async function send(key: string, value: unknown) {
    try {
      const r = await changeSetting(key, value);
      setMsg({ ok: r.ok, text: r.ok ? r.detail : `${r.detail}${r.command ? ` — run: ${r.command}` : ''}` });
    } catch (e) { setMsg({ ok: false, text: `${e instanceof Error ? e.message : String(e)} — or run: ashlr settings set ${key} ${String(value)}` }); }
  }
  function change(key: string, value: unknown) {
    setMsg(null);
    if (hold.hasHold) void send(key, value);
    else { setPending({ key, value }); setTokenOpen(true); }
  }
  useEffect(() => {
    if (tokenOpen || !pending) return;
    if (hold.hasHold) void send(pending.key, pending.value);
    setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when the token dialog closes.
  }, [tokenOpen]);

  const s = q.data;
  if (!s) {
    return <div className={styles.view}><h1 className={styles.title}>Settings</h1>{q.error
      ? <ErrorState what="Settings" error={q.error} fix="ashlr settings --json" />
      : <p className={styles.hint}>Loading settings…</p>}</div>;
  }
  return (
    <div className={styles.view}>
      <h1 className={styles.title}>Settings</h1>
      {msg ? <p role="status" className={msg.ok ? styles.ok : styles.error}>{msg.text}</p> : null}
      <Section title="Autonomy" hint={s.autonomy.grantActive ? 'The standing grant allows up to Autonomous.' : 'No active grant — Autonomous needs `ashlr ecosystem up` (Touch ID).'}>
        <div className={styles.segmented} role="radiogroup" aria-label="Autonomy level">
          {(['off', 'propose', 'autonomous'] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={s.autonomy.level === l} className={s.autonomy.level === l ? styles.segOn : styles.seg} disabled={l === 'autonomous' && s.autonomy.maxLevel !== 'autonomous'} onClick={() => change('autonomy.level', l)}>{l}</button>
          ))}
        </div>
      </Section>
      <Section title="Repos">
        {s.repos.enrolled.length === 0 ? <p className={styles.hint}>No repos enrolled. Use Control → Ecosystem, or run <code>ashlr ecosystem up</code>.</p> : (
          <ul className={styles.list}>{s.repos.enrolled.map((r) => <li key={r}><span>{r}</span><button type="button" className={styles.link} onClick={() => change('repos.unenroll', r)}>Remove</button></li>)}</ul>
        )}
      </Section>
      <Section title="Schedules">
        {s.schedules.length === 0 ? <p className={styles.hint}>No schedules yet. <code>ashlr ecosystem up</code> adds the steward schedule.</p> : (
          <ul className={styles.list}>{s.schedules.map((a) => (
            <li key={a.id}><label><input type="checkbox" checked={a.enabled} onChange={(e) => change(e.target.checked ? 'schedules.enable' : 'schedules.disable', a.id)} /> {a.name}</label></li>
          ))}</ul>
        )}
      </Section>
      <Section title="Models" hint="Engines the fleet may use.">
        <p>{s.models.allowedEngines?.join(', ') ?? 'All configured engines'}</p>
      </Section>
      <Section title="Budget caps">
        <p>${s.budget.dailyUsd}/day · {s.budget.perItemMaxTokens ?? '—'} tokens per item · {s.budget.maxConcurrent ?? '—'} concurrent</p>
        <form className={styles.row} onSubmit={(e) => { e.preventDefault(); const n = Number(budget); if (Number.isFinite(n)) change('budget.dailyUsd', n); else setMsg({ ok: false, text: 'Enter a dollar amount, e.g. 5' }); }}>
          <label>Daily USD <input aria-label="Daily USD" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={String(s.budget.dailyUsd)} inputMode="decimal" /></label>
          <button type="submit">Save</button>
        </form>
      </Section>
      <Section title="Notifications">
        <label className={styles.row}><input type="checkbox" checked={s.notifications.desktop} onChange={(e) => change('notifications.desktop', e.target.checked)} /> Desktop notification when a proposal needs you</label>
        <label className={styles.row}><input type="checkbox" checked={s.notifications.proactive} onChange={(e) => change('notifications.proactive', e.target.checked)} /> Proactive fleet updates (Telegram)</label>
        <p className={styles.hint}>Slack {s.notifications.slack ? 'set' : 'not set'} · Discord {s.notifications.discord ? 'set' : 'not set'} (webhooks are set in ~/.ashlr/config.json)</p>
      </Section>
      <Section title="Constitution" hint={s.constitution.path ?? 'No AGENTS.md found — set $ASHLR_CONSTITUTION or run `ashlr ecosystem up`.'}>
        <textarea aria-label="Constitution text" className={styles.editor} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste the new AGENTS.md text; the current text is kept as a version you can revert to." />
        <div className={styles.row}><button type="button" disabled={!draft.trim() || !s.constitution.path} onClick={() => change('constitution.save', { text: draft, note: 'console edit' })}>Save new version</button></div>
        {s.constitution.versions.length === 0 ? <p className={styles.hint}>No earlier versions yet.</p> : (
          <ul className={styles.list}>{s.constitution.versions.map((v) => <li key={v.id}><span>{new Date(v.at).toLocaleString()} · {v.note} · {v.bytes} B</span><button type="button" className={styles.link} onClick={() => change('constitution.revert', v.id)}>Revert to this</button></li>)}</ul>
        )}
      </Section>
      <MutationTokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} reason="Changing settings requires the dispatch token." />
    </div>
  );
}
