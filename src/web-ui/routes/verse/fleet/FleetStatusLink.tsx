/**
 * routes/verse/fleet/FleetStatusLink.tsx — Command's one line about the fleet
 * (3.15). The fleet is operated in ONE place, the Fleet tab; Command states
 * where it stands and links there, instead of repeating its controls, its
 * ladder or its setup steps.
 *
 *   ● Running · 3 agents working · stage shadow            [Open Fleet ⌘2]
 *     Running 3 of 5. Usage 40%, resets in 3 h. …   (the phone's glance, same words)
 */
import type { GuardianGlanceRow } from '../../../../core/fleet/guardian-glance.js';
import { formatOperatorGlance } from '../../../../core/fleet/operator-glance.js';
import type { FleetControlStateV1 } from '../../../../core/fleet/fleet-control-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { operatorGlanceQuery } from '../mobile/operator-glance-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { setVerseSection } from '../verse-ui-store.js';
import { detectKeyPlatform, formatChord } from '../shell/command-catalog.js';
import { commandChord } from '../shell/command-keys.js';
import { fleetControlQuery } from './fleet-control-queries.js';
import styles from './fleet-control.module.css';

const TONE: Record<FleetControlStateV1['state'], string> = {
  running: 'running',
  idle: 'ok',
  paused: 'warning',
  stopped: 'danger',
  blocked: 'danger',
  off: 'muted',
};

const rank = (row: GuardianGlanceRow): number => (row.state === 'red' ? 0 : row.stale ? 1 : 2);
const tone = (row: GuardianGlanceRow): string => (row.state === 'red' ? 'danger' : row.stale ? 'warning' : 'ok');
const age = (minutes: number | null): string => (minutes === null ? 'never' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`);

/** One compact row of main-guardian chips: red, then stale, then green. */
export function GuardianRow({ guardian }: { guardian?: readonly GuardianGlanceRow[] }) {
  if (!guardian || guardian.length === 0) return null;
  return (
    <p className={styles.statusLinkLine} data-testid="guardian-row" aria-label="Main guardian">
      {[...guardian].sort((a, b) => rank(a) - rank(b)).map((row) => (
        <span key={row.repo} title={`${row.repo} main ${row.state}`}>
          <span className={styles.dot} data-tone={tone(row)} aria-hidden="true" /> {row.repo} {age(row.ageMinutes)}{row.openFixes ? ` · ${row.openFixes} fix` : ''}
        </span>
      ))}
    </p>
  );
}

export function FleetStatusLink() {
  const read = useQuery(fleetControlQuery, { freshMs: 10_000 });
  const glanceRead = useQuery(operatorGlanceQuery);
  const refetchGlance = useRefetch(operatorGlanceQuery);
  usePollWhileVisible(() => { refetchGlance(); }, 15_000);
  const state = read.data?.value ?? null;
  // A failed or 404 glance read is silent here: the line stays as it was.
  const glance = glanceRead.data ?? null;
  // Neither an older server's control route nor a glance: nothing to link from.
  if (!state && !glance) return null;
  const at = glance ? Date.parse(glance.at) : NaN;
  const lines = glance ? formatOperatorGlance(glance, Number.isFinite(at) ? at : Date.now()).split('\n') : [];
  const chord = commandChord('surface.fleet');
  const key = chord ? formatChord(chord, detectKeyPlatform()) : null;
  const blocker = state?.blocker ?? null;
  const anchor = !state || blocker ? 'fleet-control' : state.grant.state === 'active' ? 'autonomy' : 'fleet-control';
  return (
    <div className={styles.statusLink} data-testid="fleet-status-link" data-state={state?.state}>
      <div className={styles.statusLinkText}>
        {state ? (
          <p className={styles.statusLinkLine}>
            <span className={styles.dot} data-tone={TONE[state.state]} aria-hidden="true" />
            <span>{state.headline}</span>
          </p>
        ) : null}
        {lines.map((line) => (
          <p key={line} className={styles.statusLinkGlance} data-tone={/Main needs you|Incidents:|unknown/.test(line) ? 'attention' : undefined}>{line}</p>
        ))}
        <GuardianRow guardian={glance?.guardian} />
      </div>
      <Button size="sm" variant={blocker ? 'primary' : 'subtle'} onClick={() => setVerseSection('fleet', anchor)} aria-keyshortcuts={key ?? undefined}>
        {blocker && blocker.action.kind !== 'wait' ? `${blocker.action.label} in Fleet` : 'Open Fleet'}
        {key ? <kbd className={styles.kbd}>{key}</kbd> : null}
      </Button>
    </div>
  );
}
