/**
 * routes/verse/sections/AboutPanel.tsx: what this is and which build it is.
 * The version comes from package.json at build time (./app-version.ts).
 */
import { PRODUCT_COMPANY, PRODUCT_DESCRIPTOR } from '../../../app/product-brand.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Tag } from '../../../components/primitives/index.js';
import { APP_NAME, APP_VERSION, installedDesktopVersion } from './app-version.js';
import { Panel } from './SettingRow.js';
import styles from './SettingsSection.module.css';

export function AboutPanel() {
  const desktopVersion = installedDesktopVersion();
  return (
    <Panel title="About">
      <div className={`${styles.row} ${styles.rowStacked}`}>
        <div className={styles.about}>
          <p className={styles.aboutName}>{APP_NAME}</p>
          <p className={styles.aboutLine}>
            <Tag mono>v{desktopVersion ?? APP_VERSION}</Tag>
            <span>{desktopVersion ? 'Installed desktop' : 'Interface build'}</span>
          </p>
          {desktopVersion && desktopVersion !== APP_VERSION ? (
            <p className={styles.aboutLine}>
              <span>Interface build</span><Tag mono>v{APP_VERSION}</Tag>
            </p>
          ) : null}
          <p className={styles.aboutLine}>Build versions identify this interface and desktop shell; release availability is separate.</p>
          <p className={styles.aboutLine}>{PRODUCT_DESCRIPTOR} · by {PRODUCT_COMPANY}</p>
          <p className={styles.aboutLine}>
            Work with agents in chat or delegate fleet outcomes. Sessions use the providers and accounts you connect.
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
