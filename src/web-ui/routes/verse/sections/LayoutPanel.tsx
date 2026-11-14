/**
 * routes/verse/sections/LayoutPanel.tsx — where things sit: sidebar and
 * resources width, and which panels are shown. Reads and writes
 * verse-ui-store directly (the shell's own state); data/ui-settings-sync.ts
 * mirrors those fields into ~/.ashlr/ui.json, so a change here and an edit to
 * the file are the same setting.
 */
import { useId } from 'react';
import { Button, Slider, Switch } from '../../../components/primitives/index.js';
import {
  setVerseRailExpanded,
  setVerseResourcesOpen,
  setVerseResourcesWidth,
  setVerseSidebarCollapsed,
  setVerseSidebarWidth,
  VERSE_RESOURCES,
  VERSE_SIDEBAR,
} from '../verse-ui-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { Panel, SettingRow } from './SettingRow.js';

export function LayoutPanel() {
  const ui = useVerseUi();
  const sidebarId = useId();
  const resourcesId = useId();
  const atDefaults =
    ui.sidebarWidth === VERSE_SIDEBAR.def && !ui.sidebarCollapsed && ui.resourcesOpen
    && ui.resourcesWidth === VERSE_RESOURCES.def && !ui.railExpanded;
  const reset = () => {
    setVerseSidebarWidth(VERSE_SIDEBAR.def);
    setVerseSidebarCollapsed(false);
    setVerseResourcesOpen(true);
    setVerseResourcesWidth(VERSE_RESOURCES.def);
    setVerseRailExpanded(false);
  };
  return (
    <Panel
      title="Layout"
      action={<Button variant="ghost" size="sm" onClick={reset} disabled={atDefaults}>Reset layout</Button>}
    >
      <SettingRow label="Sidebar width" description="Default width of the chat and session sidebar." stacked>
        <Slider
          id={sidebarId}
          label="Width"
          min={VERSE_SIDEBAR.min}
          max={VERSE_SIDEBAR.max}
          value={ui.sidebarWidth}
          valueLabel={`${ui.sidebarWidth}px`}
          valueText={`${ui.sidebarWidth} pixels`}
          onChange={(e) => setVerseSidebarWidth(Number(e.currentTarget.value))}
        />
      </SettingRow>
      <SettingRow label="Resources width" description="Default width of the resources panel." stacked>
        <Slider
          id={resourcesId}
          label="Width"
          min={VERSE_RESOURCES.min}
          max={VERSE_RESOURCES.max}
          value={ui.resourcesWidth}
          valueLabel={`${ui.resourcesWidth}px`}
          valueText={`${ui.resourcesWidth} pixels`}
          onChange={(e) => setVerseResourcesWidth(Number(e.currentTarget.value))}
        />
      </SettingRow>
      <SettingRow label="Sidebar" description="Show the sidebar. Off collapses it out of the way.">
        <Switch aria-label="Show sidebar" checked={!ui.sidebarCollapsed} onChange={(show) => setVerseSidebarCollapsed(!show)} />
      </SettingRow>
      <SettingRow label="Resources panel" description="Show the resources panel.">
        <Switch aria-label="Show resources panel" checked={ui.resourcesOpen} onChange={setVerseResourcesOpen} />
      </SettingRow>
      <SettingRow label="Expanded rail" description="Show labels beside the rail icons.">
        <Switch aria-label="Expanded rail" checked={ui.railExpanded} onChange={setVerseRailExpanded} />
      </SettingRow>
    </Panel>
  );
}
