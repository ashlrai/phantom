/**
 * routes/verse/sections/ConfigFilePanel.tsx — the agent-native face of
 * Settings. Appearance and Layout are views over ONE file,
 * ~/.ashlr/ui.json; this panel shows where it is, lets you copy the path
 * (hand it to an agent: "edit this file"), shows what the file says, and
 * reloads it after an outside edit. The text box edits the document directly
 * — the same bytes an agent would write — and the server's complaints about
 * unknown or out-of-range values come back verbatim.
 */
import { useEffect, useId, useState } from 'react';
import { copyText } from '../../../components/primitives/clipboard.js';
import { Button } from '../../../components/primitives/index.js';
import {
  currentUiSettingsText,
  reloadUiSettingsFromFile,
  saveUiSettingsText,
  useUiSettingsStatus,
} from '../../../data/ui-settings-sync.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

const PHASE_TEXT = {
  idle: 'Not read yet',
  synced: 'In sync with the file',
  saving: 'Saving…',
  'local-only': 'Not written to the file',
} as const;

export function ConfigFilePanel() {
  const status = useUiSettingsStatus();
  const editorId = useId();
  const [text, setText] = useState(currentUiSettingsText);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  // Follow the file (and the Appearance/Layout controls) while no edit is pending.
  useEffect(() => {
    if (!dirty) setText(currentUiSettingsText());
  }, [status, dirty]);

  const copy = async () => {
    if (!status.path) return;
    setCopied((await copyText(status.path)) ? 'ok' : 'failed');
  };
  const reload = async () => {
    setBusy(true);
    try {
      await reloadUiSettingsFromFile();
      setDirty(false);
      setProblems([]);
    } catch {
      setProblems(['Could not read the file from the server.']);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    const result = await saveUiSettingsText(text);
    setBusy(false);
    setProblems(result.problems);
    if (result.ok || result.problems.every((p) => p.startsWith('unknown') || p.startsWith('invalid'))) setDirty(false);
  };
  const shown = [...status.problems, ...problems];

  return (
    <Panel
      title="Config file"
      action={<Button variant="ghost" size="sm" onClick={reload} disabled={busy}>Reload from file</Button>}
    >
      <p className={styles.panelNote}>
        Appearance and Layout are stored in one JSON file. Edit it here, in an editor, or ask an agent to — changes
        appear after “Reload from file” or the next launch.
      </p>
      <SettingRow label="Location" description={PHASE_TEXT[status.phase]}>
        <div className={styles.configPath}>
          <code className={styles.code}>{status.path ?? '~/.ashlr/ui.json'}</code>
          <Button variant="subtle" size="sm" onClick={copy} disabled={!status.path} aria-label="Copy file path">
            {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy path'}
          </Button>
        </div>
      </SettingRow>
      {status.detail ? <p className={styles.panelNote} role="status">{status.detail}</p> : null}
      <SettingRow label="Contents" htmlFor={editorId} stacked description="Every key is optional; unknown keys are ignored and reported below.">
        <textarea
          id={editorId}
          className={styles.configEditor}
          spellCheck={false}
          rows={14}
          value={text}
          onChange={(e) => { setText(e.currentTarget.value); setDirty(true); }}
        />
        <div className={styles.configActions}>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !dirty}>Save to file</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDirty(false); setProblems([]); }} disabled={!dirty}>Discard edits</Button>
        </div>
      </SettingRow>
      {shown.length > 0 ? (
        <ul className={styles.panelNote} role="alert" aria-label="Problems with the settings file">
          {shown.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
    </Panel>
  );
}
