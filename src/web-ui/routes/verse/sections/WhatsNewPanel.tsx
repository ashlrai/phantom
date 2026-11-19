/**
 * routes/verse/sections/WhatsNewPanel.tsx: what changed since the installed
 * version, in plain words. The three-sentence summary comes first; each heading
 * is a collapsed list below it. Backed by GET /api/verse/app/whats-new, the
 * same notes as `phm release notes --markdown`. Unknown stays unknown.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Panel } from './SettingRow.js';
import styles from './WhatsNewPanel.module.css';

export const WHATS_NEW_PATH = '/api/verse/app/whats-new';
export interface WhatsNewLine { text: string; count: number }
export interface WhatsNew {
  installed: string | null;
  headline: string[];
  sections: { heading: string; lines: WhatsNewLine[] }[];
  reason: string | null;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The response read, or null for anything that is not the v:1 shape. */
export function readWhatsNew(raw: unknown): WhatsNew | null {
  if (!record(raw) || raw['v'] !== 1 || !Array.isArray(raw['headline']) || !Array.isArray(raw['sections'])) return null;
  const sections = raw['sections'];
  if (!raw['headline'].every((line) => typeof line === 'string')) return null;
  const valid = sections.every((section) => record(section) && typeof section['heading'] === 'string' && Array.isArray(section['lines'])
    && section['lines'].every((line) => record(line) && typeof line['text'] === 'string' && Number.isSafeInteger(line['count'])));
  if (!valid) return null;
  return { installed: typeof raw['installed'] === 'string' ? raw['installed'] : null, headline: raw['headline'] as string[],
    sections: sections as WhatsNew['sections'], reason: typeof raw['reason'] === 'string' ? raw['reason'] : null };
}

const whatsNewQuery: QueryDef<unknown> = { key: 'verse-app-whats-new', fetch: (signal) => apiGet<unknown>(WHATS_NEW_PATH, signal) };
const UNKNOWN: Record<string, string> = {
  'installed-version-unknown': 'The installed version is unknown, so what changed since it cannot be listed.',
  'history-unavailable': 'The change history for this version is not available on this machine.',
};

export function WhatsNewPanel() {
  const query = useQuery(whatsNewQuery, { freshMs: 300_000 });
  const notes = query.status === 'error' ? null : readWhatsNew(query.data);
  const title = notes?.installed ? `What's new since ${notes.installed}` : "What's new";
  let body;
  if (query.status === 'error' || (query.status !== 'loading' && query.status !== 'idle' && !notes)) body = <p className={styles.note}>What changed is unknown right now.</p>;
  else if (!notes) body = <p className={styles.note}>Loading what changed...</p>;
  else if (notes.reason) body = <p className={styles.note}>{UNKNOWN[notes.reason] ?? 'What changed is unknown.'}</p>;
  else body = (
    <div className={styles.notes}>
      <p className={styles.summary}>{notes.headline.join(' ')}</p>
      {notes.sections.map((section) => (
        <details key={section.heading} className={styles.section}>
          <summary className={styles.heading}>{section.heading}</summary>
          <ul className={styles.lines}>
            {section.lines.map((line) => <li key={line.text}>{line.text}{line.count > 1 ? ` (${line.count} changes)` : ''}</li>)}
          </ul>
        </details>
      ))}
    </div>
  );
  return <Panel title={title}>{body}</Panel>;
}
