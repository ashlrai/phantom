import { useId } from 'react';
import { setFeatureFlag, useFeatureFlag } from '../../../app/desktop-state.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { Panel, SettingRow } from './SettingRow.js';

export function WorkspaceSettingsPanel() {
  const enabled = useFeatureFlag('agentWorkspace');
  const oneAsk = useFeatureFlag('oneAsk');
  const id = useId();
  const askId = useId();
  return (
    <Panel title="Workspace">
      <SettingRow
        label="Agent workspace"
        description="Opt in to agent workspace features as they become available. Off by default; saved in this browser."
        htmlFor={id}
      >
        <Switch id={id} aria-label="Agent workspace" checked={enabled} onChange={(next) => setFeatureFlag('agentWorkspace', next)} />
      </SettingRow>
      <SettingRow
        label="One ask"
        description="Show the ask bar: post a change request to the local bus as ask.v1 and watch its status chips. Off by default; saved in this browser."
        htmlFor={askId}
      >
        <Switch id={askId} aria-label="One ask" checked={oneAsk} onChange={(next) => setFeatureFlag('oneAsk', next)} />
      </SettingRow>
    </Panel>
  );
}
