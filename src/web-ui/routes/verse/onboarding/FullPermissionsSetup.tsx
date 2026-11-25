import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { buildPermissionRows, type PermissionObservations } from '../../../../core/permissions-onboarding.js';
import type { ComputerSettingsKind } from '../../../../core/verse/computer-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { authoritySetupQuery, CopyCommand } from '../autonomy/AutonomyOffState.js';
import SetupChecklist from '../autonomy/SetupChecklist.js';
import { localRequestId, nativeComputer, type NativeComputer } from '../computer/native-computer.js';
import { Panel, SettingRow } from '../sections/SettingRow.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { LiveCapacityStrip } from '../usage/CapacityStrip.js';
import { setVerseSection } from '../verse-ui-store.js';
import styles from './onboarding.module.css';

const GUIDE_COMMAND = 'phm authority setup --full-permissions';
const LABEL = { granted: 'Granted', missing: 'Missing', unknown: 'Needs review' };

/** Opens only on a user action. No grant, prompt, account read or native probe on mount. */
export default function FullPermissionsSetup() {
  const [open, setOpen] = useState(false);
  return <Panel title="Full permissions setup">
    <SettingRow label="Set up this device" description="Review macOS access, custody, GitHub, your authority level and connected agents. Each permission is your choice.">
      <Button variant="subtle" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close setup' : 'Review permissions'}</Button>
    </SettingRow>
    {open ? <PermissionsGuide /> : null}
  </Panel>;
}

export function PermissionsGuide({ bridge = nativeComputer() }: { bridge?: NativeComputer | null }) {
  // Keep one bridge for this mounted guide; requests must settle against the same window.
  const native = useRef(bridge).current;
  const [step, setStep] = useState(0);
  const [observed, setObserved] = useState<PermissionObservations>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<'off' | 'propose' | 'autonomous'>('off');
  const titleId = useId();
  const rows = buildPermissionRows(observed);

  const check = useCallback(async (request?: 'screen' | 'accessibility') => {
    if (!native || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setObserved({});
    try {
      let result = await native.request({ op: 'permissions', req: localRequestId() }, 10_000);
      if (!alive.current) return;
      // Recheck immediately before a prompt. A stale missing row cannot re-prompt a grant.
      if (request && result.ok && result.data && typeof result.data === 'object' &&
          (result.data as Record<string, unknown>)[request] === false) {
        result = await native.request({ op: 'request-permission', req: localRequestId(), kind: request });
      }
      if (!alive.current) return;
      if (result.ok && result.data && typeof result.data === 'object') setObserved(result.data as PermissionObservations);
      else setError(result.ok ? 'Permission status was not reported.' : result.error);
    } catch {
      if (alive.current) setError('Permission status could not be checked. Try again.');
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, [native]);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => { alive.current = false; };
    // One nonprompting read per opened guide. Rechecks are explicit user actions.
  }, [check]);

  function settings(kind: ComputerSettingsKind) {
    setError(null);
    if (!native?.send({ op: 'open-settings', kind })) setError('System Settings could not be opened. Open Privacy & Security manually.');
  }

  return <div className={styles.body} aria-labelledby={titleId}>
    <h4 id={titleId}>{['1. macOS permissions', '2. Authority and custody', '3. Connect agents'][step]}</h4>
    {step === 0 ? <>
      <p>These observations apply to Phantom desktop. Terminal and agent launchers need their own permissions. Grant only the access you want to use.</p>
      {!native ? <p role="status">Open Phantom desktop on macOS to check its permissions. This browser cannot observe them.</p> : null}
      <Button variant="subtle" size="sm" disabled={!native || busy} onClick={() => void check()}>{busy ? 'Checking permissions…' : 'Check permissions again'}</Button>
      {error ? <p role="alert">{error}</p> : null}
      {rows.map((row) => {
        const request = row.id === 'screen' || row.id === 'accessibility' ? row.id : null;
        const kind = row.id.startsWith('automation-') ? 'automation' : row.id as ComputerSettingsKind;
        return <SettingRow key={row.id} label={`${row.label}: ${LABEL[row.status]}`} description={`${row.detail} ${row.reason}`}>
          {row.status !== 'granted' ? <Button variant="subtle" size="sm" disabled={!native || busy}
            aria-label={`${request && row.status === 'missing' ? 'Request' : 'Review'} ${row.label}`}
            onClick={() => request && row.status === 'missing' ? void check(request) : settings(kind)}>
            {request && row.status === 'missing' ? 'Request permission' : 'Open Settings'}
          </Button> : null}
        </SettingRow>;
      })}
      <p>In System Settings, choose Privacy &amp; Security, then the named permission. Full Disk Access and Developer Tools require manual review. Restart Phantom if macOS asks, then recheck.</p>
      <CopyCommand command={`${GUIDE_COMMAND} --json`} />
    </> : step === 1 ? <>
      <AuthoritySetup />
      <SettingRow label="Your authority level" labelId={`${titleId}-level-label`} description="Review the existing grant sheet before Touch ID. Stop, revoke and the signed grant remain in control.">
        <select aria-labelledby={`${titleId}-level-label`} value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
          <option value="off">Off</option><option value="propose">Propose</option><option value="autonomous">Autonomous</option>
        </select>
      </SettingRow>
      <Button variant="subtle" onClick={() => executeCatalogCommand(`autonomy.${level}`, { via: 'button' })}>
        Set authority to {level === 'off' ? 'Off' : level === 'propose' ? 'Propose' : 'Autonomous'}
      </Button>
      <p>This applies your choice within the existing signed grant, or opens the Touch ID grant review if a new grant is needed. Choosing Autonomous can resume work by an already running fleet. Stop and revoke remain available on Command.</p>
    </> : <>
      <LiveCapacityStrip density="compact" headline local="collapse" labelledBy={titleId} emptyText="No connected agents reported. Connect an account in Apps & Accounts." />
      <Button variant="subtle" onClick={() => setVerseSection('apps')}>Connect agents in Apps &amp; Accounts</Button>
      <p>Use each provider's sign-in flow. A connected account does not grant authority or approve spending. Return here to check status after connecting.</p>
    </>}
    <div className={styles.findingFix}>
      <Button variant="subtle" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</Button>
      {step < 2 ? <Button variant="subtle" disabled={busy} onClick={() => setStep(step + 1)}>Continue</Button> : <Button variant="subtle" onClick={() => setStep(0)}>Review permissions again</Button>}
    </div>
  </div>;
}

function AuthoritySetup() {
  const read = useQuery(authoritySetupQuery);
  const refresh = useRefetch(authoritySetupQuery);
  return <>
    <p>Custody and GitHub App setup use the existing authority checklist. Run the guided command in your terminal for any missing prerequisite.</p>
    <CopyCommand command={GUIDE_COMMAND} />
    {read.data?.value ? <SetupChecklist report={read.data.value} open /> : <p role="status">{read.status === 'error' || read.data ? 'Authority setup could not be read. Retry or use the guided command.' : 'Checking authority setup…'}</p>}
    <Button variant="subtle" size="sm" onClick={refresh}>Check authority setup again</Button>
  </>;
}
