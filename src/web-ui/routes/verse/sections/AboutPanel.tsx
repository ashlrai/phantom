/**
 * routes/verse/sections/AboutPanel.tsx: what this is and which build it is.
 * The version comes from package.json at build time (./app-version.ts).
 */
import { useEffect, useState } from 'react';
import { PRODUCT_COMPANY, PRODUCT_DESCRIPTOR } from '../../../app/product-brand.js';
import { PhantomMark } from '../../../app/product-brand-mark.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Button, Tag } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openPaneInChat } from '../dock/dock-store.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { setVerseSection } from '../verse-ui-store.js';
import { aboutDiagnosticsText } from './about-diagnostics.js';
import { aboutUpdateLines } from './about-update-model.js';
import { APP_NAME, APP_VERSION, installedDesktopVersion } from './app-version.js';
import { Panel } from './SettingRow.js';
import { updateStatusQuery } from './update-status-queries.js';
import { versionSkewNote } from './version-skew.js';
import styles from './SettingsSection.module.css';

export function AboutPanel() {
  const desktopVersion = installedDesktopVersion();
  const visible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(updateStatusQuery, { enabled: visible && documentVisible, freshMs: 60_000 });
  const poll = useRefetch(updateStatusQuery);
  usePollWhileVisible(poll, 60_000);
  const observation = query.status === 'error' ? null : query.data ?? null;
  const reading = !observation && query.status !== 'error';
  const status = reading
    ? { tone: 'unknown' as const, headline: 'Reading self-update status…', rows: [] }
    : aboutUpdateLines(observation, Date.now());
  const why = query.status === 'error'
    ? 'The console could not read the update route. Try again, or open the Releases pane.'
    : !reading && status.headline === 'Self-update status unavailable.'
      ? 'This install has no source checkout the console can compare, so there is no fetch or fast-forward to report.'
      : null;
  const serverVersion = observation && !('kind' in observation) ? observation.installedVersion : null;
  const skew = versionSkewNote({ desktop: desktopVersion, iface: APP_VERSION, server: serverVersion });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice === '') return;
    const timer = setTimeout(() => setNotice(''), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const copyDiagnostics = async () => {
    const text = aboutDiagnosticsText({
      appName: APP_NAME,
      desktopVersion,
      interfaceVersion: APP_VERSION,
      serverVersion,
      status,
      skew,
      nowIso: new Date().toISOString(),
    });
    try { await navigator.clipboard.writeText(text); setNotice('Copied'); }
    catch { setNotice('Copy failed'); }
  };
  return (
    <Panel title="About">
      <div className={`${styles.row} ${styles.rowStacked}`}>
        <div className={styles.about}>
          <p className={styles.aboutName}><PhantomMark size={32} /> {APP_NAME}</p>
          <p className={styles.aboutLine}>
            <Tag mono>v{desktopVersion ?? APP_VERSION}</Tag>
            <span>{desktopVersion ? 'Installed desktop' : 'Interface build'}</span>
          </p>
          {desktopVersion && desktopVersion !== APP_VERSION ? (
            <p className={styles.aboutLine}>
              <span>Interface build</span><Tag mono>v{APP_VERSION}</Tag>
            </p>
          ) : null}
          {serverVersion ? <p className={styles.aboutLine}><span>Installed Phantom</span><Tag mono>v{serverVersion}</Tag></p> : null}
          {skew ? <p className={styles.aboutLine} data-tone={skew.tone}><Tag size="sm" className={styles[skew.tone === 'warning' ? 'aboutStatus_behind' : 'aboutStatus_unknown']}>{skew.text}</Tag></p> : null}
          <p className={styles.aboutLine} aria-live="polite">
            <Tag size="sm" className={styles[`aboutStatus_${status.tone}`]} aria-busy={reading || undefined}>{status.headline}</Tag>
            {query.status === 'error' ? <Button size="sm" onClick={() => void poll()}>Retry</Button> : null}
          </p>
          {why ? <p className={styles.panelNote} data-testid="about-update-why">{why}</p> : null}
          {status.rows.map((row) => (
            <p className={styles.aboutLine} key={row.label}>
              <span>{row.label}</span>{row.mono ? <Tag mono>{row.value}</Tag> : <span>{row.value}</span>}
            </p>
          ))}
          <p className={styles.aboutLine}>
            <Button size="sm" onClick={() => { setVerseSection('chat'); openPaneInChat('fleet-releases'); }}>Open Releases pane</Button>
            <Button size="sm" onClick={() => void copyDiagnostics()}><span aria-live="polite">{notice === '' ? 'Copy diagnostics' : notice}</span></Button>
          </p>
          <p className={styles.aboutLine}>{PRODUCT_DESCRIPTOR} · by {PRODUCT_COMPANY}</p>
          <p className={styles.aboutLine}>
            Work with agents in chat or delegate fleet outcomes. Sessions use the providers and accounts you connect.
          </p>
          <p className={styles.aboutLine}>
            Build versions identify this interface and desktop shell; they do not confirm publication.
          </p>
          <p className={styles.aboutLine}>
            <a
              className={styles.link}
              href="https://github.com/ashlrai/phantom"
              target="_blank"
              rel="noreferrer noopener"
            >
              Source repository
              <IconExternalLink size={12} />
            </a>
          </p>
        </div>
      </div>
    </Panel>
  );
}
