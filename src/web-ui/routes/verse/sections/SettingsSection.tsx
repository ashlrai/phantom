/**
 * routes/verse/sections/SettingsSection.tsx — the Settings rail item
 * (VERSE-CONTRACT-V2, owner A). Named export, NO props: the shell
 * lazy-mounts it and it reads everything it needs from the stores.
 *
 * A short grouped page: a left nav (General, Appearance, Accounts &
 * resources, Updates, Autonomy, Team, About, All settings) and a search box.
 * Only the selected group's panels mount, so opening Settings starts that
 * group's reads rather than every panel's (the single long column mounted
 * ~2,300 nodes and ~14 reads at once). Search matches static titles and
 * keywords (settings-groups.ts) and mounts only the matching panels. Each row
 * is still label + description on the left, control on the right.
 *
 * 3.10: reached from the gear tray (⌘,), not the rail.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useAppearance } from '../../../data/appearance-hooks.js';
import { PhantomMark } from '../../../app/product-brand-mark.js';
import { OnboardingPanel } from '../onboarding/OnboardingPanel.js';
import { EcosystemWizard } from '../onboarding/EcosystemWizard.js';
import { TeamPanel } from '../onboarding/TeamPanel.js';
import { Input, Tag } from '../../../components/primitives/index.js';
import { lastVerseAnchor, VERSE_ANCHOR_EVENT, type VerseAnchorRequest } from '../verse-ui-store.js';
import { APP_NAME, APP_VERSION, installedDesktopVersion } from './app-version.js';
import { AboutPanel } from './AboutPanel.js';
import { WhatsNewPanel } from './WhatsNewPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { BuildLimitsRow } from './BuildLimitsRow.js';
import { ChatSettingsPanel } from './ChatSettingsPanel.js';
import { CommsLimitsRow } from './CommsLimitsRow.js';
import { ConfigFilePanel } from './ConfigFilePanel.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { QuietHoursRow } from './QuietHoursRow.js';
import { DesktopSettingsPanel } from './DesktopSettingsPanel.js';
import { LayoutPanel } from './LayoutPanel.js';
import { PlannerSlatePanel } from './PlannerSlatePanel.js';
import { ResidentAwakePanel } from './ResidentAwakePanel.js';
import { ShortcutsPanel } from './ShortcutsPanel.js';
import { UpdatesPanel } from './UpdatesPanel.js';
import { WorkspaceSettingsPanel } from './WorkspaceSettingsPanel.js';
import { ConnectorsSettings } from '../../settings/connectors/ConnectorsView.js';
import {
  SETTINGS_ANCHOR_GROUPS,
  SETTINGS_GROUPS,
  panelsInGroup,
  searchSettings,
  setSettingsView,
  useSettingsView,
  type SettingsPanelEntry,
  type SettingsPanelId,
} from './settings-groups.js';
import styles from './SettingsSection.module.css';

/** An anchor request this old is a past gesture, not one Settings should follow. */
const ANCHOR_FRESH_MS = 5_000;

function followAnchor(request: VerseAnchorRequest | null): void {
  if (!request || request.section !== 'settings') return;
  const group = SETTINGS_ANCHOR_GROUPS[request.anchor];
  if (group) setSettingsView(group);
}

function SettingsPanel({ id }: { id: SettingsPanelId }): ReactNode {
  const { appearance, set, reset } = useAppearance();
  switch (id) {
    case 'chat': return <ChatSettingsPanel />;
    case 'workspace': return <WorkspaceSettingsPanel />;
    case 'desktop': return <DesktopSettingsPanel />;
    case 'quiet-hours': return <QuietHoursRow />;
    case 'keyboard': return <ShortcutsPanel />;
    case 'appearance': return <AppearancePanel appearance={appearance} onChange={set} onReset={reset} />;
    case 'layout': return <LayoutPanel />;
    case 'config-file': return <ConfigFilePanel />;
    case 'connection': return <ConnectionPanel />;
    case 'connectors': return <ConnectorsSettings />;
    case 'planner-slate': return <PlannerSlatePanel />;
    case 'ecosystem': return <EcosystemWizard />;
    case 'secrets': return <p><a href="#/settings/secrets">Phantom Secrets custody</a></p>;
    case 'updates': return <UpdatesPanel />;
    case 'whats-new': return <WhatsNewPanel />;
    case 'resident-awake': return <ResidentAwakePanel />;
    case 'build-limits': return <BuildLimitsRow />;
    case 'comms-limits': return <CommsLimitsRow />;
    case 'team': return <TeamPanel />;
    case 'about': return <AboutPanel />;
    case 'onboarding': return <OnboardingPanel />;
  }
}

function PanelList({ panels }: { panels: readonly SettingsPanelEntry[] }) {
  return <>{panels.map((panel) => <SettingsPanel key={panel.id} id={panel.id} />)}</>;
}

export function SettingsSection() {
  const desktopVersion = installedDesktopVersion();
  const view = useSettingsView();
  const [query, setQuery] = useState('');
  const searchId = useId();

  useEffect(() => {
    const recent = lastVerseAnchor();
    if (recent && Date.now() - recent.at < ANCHOR_FRESH_MS) followAnchor(recent);
    const onAnchor = (event: Event) => followAnchor((event as CustomEvent<VerseAnchorRequest>).detail);
    window.addEventListener(VERSE_ANCHOR_EVENT, onAnchor);
    return () => window.removeEventListener(VERSE_ANCHOR_EVENT, onAnchor);
  }, []);

  const searching = query.trim().length > 0;
  const matches = searching ? searchSettings(query) : [];
  const groups = view === 'all' ? SETTINGS_GROUPS : SETTINGS_GROUPS.filter((group) => group.id === view);

  return (
    <div className={styles.section}>
      <header className={styles.strip} data-app-region="drag">
        <h2 className={styles.stripTitle}>Settings</h2>
        <Tag size="sm" title={desktopVersion ? 'Installed desktop version' : 'Interface build version'}><PhantomMark size={16} /> {APP_NAME} {desktopVersion ?? APP_VERSION}</Tag>
      </header>
      <div className={styles.settingsBody}>
        <nav className={styles.settingsNav} aria-label="Settings groups" data-testid="settings-nav">
          <div className={styles.settingsSearch} role="search">
            <Input
              id={searchId}
              type="search"
              size="sm"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
              data-testid="settings-search"
            />
          </div>
          <ul className={styles.settingsNavList}>
            {[...SETTINGS_GROUPS, { id: 'all' as const, label: 'All settings', description: 'Every group on one page' }].map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className={styles.settingsNavItem}
                  aria-current={!searching && view === group.id ? 'page' : undefined}
                  title={group.description}
                  data-testid={`settings-nav-${group.id}`}
                  onClick={() => { setQuery(''); setSettingsView(group.id); }}
                >
                  {group.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.scroll}>
          <div className={styles.column} data-testid="settings-content">
            {searching ? (
              matches.length > 0
                ? <PanelList panels={matches} />
                : <p className={styles.panelNote} role="status">No settings match “{query.trim()}”.</p>
            ) : groups.map((group) => (
              view === 'all'
                ? <div key={group.id} className={styles.settingsGroup} data-settings-group={group.id}>
                    <p className={styles.settingsGroupTitle}>{group.label}</p>
                    <PanelList panels={panelsInGroup(group.id)} />
                  </div>
                : <div key={group.id} className={styles.settingsGroup} data-settings-group={group.id}>
                    <PanelList panels={panelsInGroup(group.id)} />
                  </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
