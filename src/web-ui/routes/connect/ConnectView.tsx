import { useEffect, useState } from 'react';
import { RESOURCE_CATALOG, type ResourceKind } from '../../../core/onboard/catalog.js';
import { apiGet } from '../../data/client.js';
import { pairThisComputer, setResourcePlanTier, unpairThisComputer } from '../../data/mutations.js';
import type { OnboardComputerStatus, OnboardResourceStatus, OnboardStatusReport } from '../../data/api-types.js';
import styles from './ConnectView.module.css';

const STEPS: readonly { kind: ResourceKind; title: string; description: string }[] = [
  { kind: 'subscription', title: 'Subscriptions', description: 'Explore coding tools you already use.' },
  { kind: 'apikey', title: 'API keys', description: 'Explore model providers for API access.' },
  { kind: 'local', title: 'Local models', description: 'Run models on your own hardware.' },
  { kind: 'computer', title: 'This computer', description: 'Use the computer running Phantom.' },
  { kind: 'cloud', title: 'Cloud computer', description: 'Explore remote computing resources.' },
  { kind: 'agent', title: 'Proactive agents', description: 'Explore agents that can work with you.' },
];

function statusText(resource: OnboardResourceStatus): string {
  if (resource.loginState === 'logged-in') return 'Installed and signed in';
  if (!resource.installed) return 'CLI not detected on PATH';
  if (resource.loginState === 'logged-out') return 'Installed - not signed in';
  return 'Installed - sign-in unknown';
}

function serviceText(computer: OnboardComputerStatus): string {
  if (computer.daemonRunning) return 'daemon running';
  if (!computer.serviceInstalled) return 'daemon service not installed';
  if (computer.serviceActivity === 'running') return 'daemon running';
  return `daemon service ${computer.serviceActivity}`;
}

function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : iso;
}

export function ConnectView() {
  const [report, setReport] = useState<OnboardStatusReport | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairNote, setPairNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<OnboardStatusReport>('/api/onboard/status')
      .then((next) => { if (!cancelled) setReport(next); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const byId = new Map((report?.resources ?? []).map((r) => [r.id, r] as const));
  // POST /api/onboard/plan-tier only exists on a dispatch-enabled server.
  const picksLocked = report?.dispatchEnabled === false;

  async function pickTier(resourceId: string, planTier: string | null) {
    setSaveFailed(false);
    try {
      await setResourcePlanTier(resourceId, planTier);
      setReport(await apiGet<OnboardStatusReport>('/api/onboard/status'));
    } catch {
      setSaveFailed(true);
    }
  }

  async function togglePair(paired: boolean) {
    setPairBusy(true);
    setPairNote(null);
    try {
      const result = paired ? await unpairThisComputer() : await pairThisComputer();
      setPairNote(result.ok
        ? null
        : result.steps.map((s) => s.detail).join(' ') || 'Pairing did not complete.');
      setReport(await apiGet<OnboardStatusReport>('/api/onboard/status'));
    } catch {
      setPairNote(paired ? 'Unpair request failed.' : 'Pair request failed.');
    } finally {
      setPairBusy(false);
    }
  }

  const computer = report?.computer;

  return (
    <div className={styles.page}>
      <h1>Connect Resources</h1>
      <p className={styles.intro}>
        Live detection reports which CLIs are installed and signed in. Pick the
        plan tier you pay for; it saves to your local config.
      </p>
      {loadError && (
        <p role="status" className={styles.notice}>Live detection is unavailable.</p>
      )}
      <div className={styles.grid}>
        {STEPS.map((step, index) => (
          <section className={styles.card} key={step.kind} aria-labelledby={`connect-${step.kind}`}>
            <span className={styles.step}>Step {index + 1}</span>
            <h2 id={`connect-${step.kind}`}>{step.title}</h2>
            <p>{step.description}</p>
            <ul>
              {RESOURCE_CATALOG.filter((resource) => resource.kind === step.kind).map((resource) => {
                const detected = step.kind === 'subscription' ? byId.get(resource.id) : undefined;
                return (
                  <li key={resource.id}>
                    <span className={styles.badge} aria-hidden="true">{resource.displayName.slice(0, 1)}</span>
                    <div>
                      <a href={resource.docsUrl}>{resource.displayName}</a>
                      {resource.planTiers.length > 0 && <small>{resource.planTiers.join(' · ')}</small>}
                      {detected && resource.cliBinary && (
                        <small className={styles.status}>{statusText(detected)}</small>
                      )}
                      {detected?.installed && detected.loginCommand && detected.loginState !== 'logged-in' && (
                        <small>Run <code>{detected.loginCommand}</code></small>
                      )}
                      {step.kind === 'computer' && computer && (
                        <>
                          <small className={styles.status}>
                            {computer.paired ? 'Paired' : 'Not paired'} · {serviceText(computer)} · {computer.enrolledRepos} repo(s) enrolled
                          </small>
                          {computer.pairedAt && <small>Paired {formatWhen(computer.pairedAt)}</small>}
                          {computer.lastSeenAt && <small>Last seen {formatWhen(computer.lastSeenAt)}</small>}
                          <span className={styles.pairRow}>
                            <button
                              type="button"
                              className={styles.pairButton}
                              disabled={picksLocked || pairBusy}
                              onClick={() => void togglePair(computer.paired)}
                            >
                              {computer.paired ? 'Unpair' : 'Pair this computer'}
                            </button>
                            {picksLocked && <small>Pairing needs this server running with dispatch enabled.</small>}
                          </span>
                          {pairNote && <small role="alert" className={styles.notice}>{pairNote}</small>}
                        </>
                      )}
                      {step.kind === 'subscription' && resource.planTiers.length > 0 && (
                        <select
                          aria-label={`${resource.displayName} plan tier`}
                          className={styles.plan}
                          disabled={picksLocked}
                          value={detected?.selectedPlanTier ?? ''}
                          onChange={(e) => void pickTier(resource.id, e.target.value || null)}
                        >
                          <option value="">Choose plan</option>
                          {resource.planTiers.map((tier) => (
                            <option key={tier} value={tier}>{tier}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {step.kind === 'subscription' && saveFailed && (
              <p role="alert" className={styles.notice}>Plan tier was not saved.</p>
            )}
            {step.kind === 'subscription' && picksLocked && !saveFailed && (
              <small>Plan picks save to local config when this server runs with dispatch enabled.</small>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
