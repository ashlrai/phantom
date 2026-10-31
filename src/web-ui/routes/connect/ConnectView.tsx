import { useEffect, useState } from 'react';
import { RESOURCE_CATALOG, type ResourceKind } from '../../../core/onboard/catalog.js';
import { apiGet } from '../../data/client.js';
import { setResourcePlanTier } from '../../data/mutations.js';
import type { OnboardResourceStatus, OnboardStatusReport } from '../../data/api-types.js';
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

export function ConnectView() {
  const [report, setReport] = useState<OnboardStatusReport | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

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
