import { useId } from 'react';
import { setFeatureFlag, useFeatureFlag } from '../../../app/desktop-state.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { Panel, SettingRow } from './SettingRow.js';

/** Browser-local workspace opt-in; changing it does not request authority. */
export function WorkspaceSettingsPanel() {
  const enabled = useFeatureFlag('agentWorkspace');
  const id = useId();
  return (
    <Panel title="Workspace">
      <SettingRow
        label="Agent workspace"
        description="Opt in to agent workspace features as they become available. Off by default; saved in this browser."
        htmlFor={id}
      >
        <Switch id={id} aria-label="Agent workspace" checked={enabled} onChange={(next) => setFeatureFlag('agentWorkspace', next)} />
      </SettingRow>
    </Panel>
  );
}
