/**
 * Bots: pick a template, name the bot, create it. Creation writes an agent profile, a private
 * bot folder and DISABLED crons; it never sends, dispatches or enables anything. The server
 * enforces every limit; the form only mirrors them so errors come early.
 */
import { useState, type FormEvent } from 'react';

import type { BotAvatar, BotTemplateSummary } from '../../../core/agents/bot-templates.js';
import { Button } from '../../components/primitives/Button.js';
import { Input } from '../../components/primitives/Input.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { useQuery } from '../../data/hooks.js';
import { createBotFromTemplate } from '../../data/mutations.js';
import { botsQuery, botTemplatesQuery } from '../../data/queries.js';
import styles from './BotsView.module.css';

const ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;

export function Avatar({ avatar, label }: { avatar: BotAvatar; label: string }) {
  return (
    <span
      className={styles.avatar}
      role="img"
      aria-label={`${label} avatar`}
      style={{ background: `hsl(${avatar.hue} 55% 38%)` }}
    >
      {avatar.glyph}
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function BotsView() {
  const templates = useQuery(botTemplatesQuery);
  const bots = useQuery(botsQuery);
  const [chosen, setChosen] = useState<BotTemplateSummary | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function pick(template: BotTemplateSummary) {
    setChosen(template); setId(''); setName(template.name); setError(''); setNotice('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    if (!ID_PATTERN.test(id)) { setError('Id must be 2-24 characters: lowercase letters, digits and dashes, starting with a letter.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await createBotFromTemplate({ templateId: chosen.id, id, name: name.trim() || undefined });
      setNotice(`${result.bot.name} created with ${plural(result.bot.automations.length, 'cron')} (disabled). Review them in Automations before turning them on.`);
      setChosen(null); setId(''); setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Bot could not be created.');
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.view}>
      <header>
        <p className={styles.eyebrow}>Overview</p>
        <h1 className={styles.title}>Bots</h1>
        <p className={styles.subtitle}>Start a new bot from a template. Nothing is sent, dispatched or switched on by creating one.</p>
      </header>

      <section aria-label="Templates">
        <h2 className={styles.h2}>Templates</h2>
        {templates.status === 'loading' ? <SkeletonLine width="70%" /> : templates.status === 'error' ? (
          <p role="alert">{templates.error?.message ?? 'Templates could not be loaded.'}</p>
        ) : (
          <ul className={styles.grid}>
            {(templates.data?.templates ?? []).map((t) => (
              <li key={t.id} className={styles.card} data-selected={chosen?.id === t.id}>
                <div className={styles.cardHead}>
                  <Avatar avatar={t.avatar} label={t.name} />
                  <div>
                    <strong>{t.name}</strong>
                    <div><StatusBadge status={t.role} tone="info">{t.role}</StatusBadge></div>
                  </div>
                </div>
                <p className={styles.blurb}>{t.blurb}</p>
                <p className={styles.meta}>
                  {plural(t.memorySeed, 'memory note')}, {plural(t.tasks, 'starter task')}, {plural(t.crons, 'cron')}, channels: {t.channels.join(', ')}
                </p>
                <Button type="button" size="sm" variant={chosen?.id === t.id ? 'primary' : 'subtle'} aria-label={`Use ${t.name}`} onClick={() => pick(t)}>
                  Use template
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {chosen ? (
        <form className={styles.form} onSubmit={submit} aria-label={`Create ${chosen.name}`}>
          <h2 className={styles.h2}>New bot from {chosen.name}</h2>
          <Input label="Bot id" mono maxLength={24} value={id} onChange={(e) => setId(e.target.value)} hint="Lowercase letters, digits and dashes." disabled={busy} />
          <Input label="Display name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={busy || id === ''}>{busy ? 'Creating' : 'Create bot'}</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setChosen(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <section aria-label="Your bots">
        <h2 className={styles.h2}>Your bots</h2>
        {(bots.data?.bots ?? []).length === 0 ? <p className={styles.meta}>No bots yet.</p> : (
          <ul className={styles.list}>
            {bots.data!.bots.map((b) => (
              <li key={b.id} className={styles.row}>
                <Avatar avatar={b.avatar} label={b.name} />
                <span><strong>{b.name}</strong> <code>{b.id}</code></span>
                <StatusBadge status={b.role} tone="info">{b.role}</StatusBadge>
                <span className={styles.meta}>{plural(b.automations.length, 'cron')} (disabled until you enable them)</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
