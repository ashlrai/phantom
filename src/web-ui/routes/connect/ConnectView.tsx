import { useEffect, useState } from 'react';
import { RESOURCE_CATALOG, type ResourceKind } from '../../../core/onboard/catalog.js';
import { Switch } from '../../components/primitives/Switch.js';
import { apiGet } from '../../data/client.js';
import { setResourcePlanTier, setScheduledAgentEnabled } from '../../data/mutations.js';
import type {
  OnboardBalanceRow,
  OnboardResourceStatus,
  OnboardStatusReport,
  OnboardUsageReading,
} from '../../data/api-types.js';
import styles from './ConnectView.module.css';

const STEPS: readonly { kind: ResourceKind; title: string; description: string }[] = [
  { kind: 'subscription', title: 'Subscriptions', description: 'Explore coding tools you already use.' },
  { kind: 'apikey', title: 'API keys', description: 'Explore model providers for API access.' },
  { kind: 'local', title: 'Local models', description: 'Run models on your own hardware.' },
  { kind: 'computer', title: 'This computer', description: 'Use the computer running Phantom.' },
  { kind: 'cloud', title: 'Cloud computer', description: 'Explore remote computing resources.' },
  { kind: 'agent', title: 'Proactive agents', description: 'Agents this computer runs on a schedule.' },
];

const catalogName = (id: string): string =>
  RESOURCE_CATALOG.find((r) => r.id === id)?.displayName ?? id;

function statusText(resource: OnboardResourceStatus): string {
  if (resource.loginState === 'logged-in') return 'Installed and signed in';
  if (!resource.installed) return 'CLI not detected on PATH';
  if (resource.loginState === 'logged-out') return 'Installed - not signed in';
  return 'Installed - sign-in unknown';
}

function evidenceText(row: OnboardBalanceRow): string {
  switch (row.evidence) {
    case 'signed-in': return 'signed in';
    case 'installed': return row.connected ? 'installed' : 'installed, not signed in';
    case 'key-present': return 'API key present';
    case 'serving': return 'serving locally';
    case 'scheduled-agents': return 'scheduled agents on';
    case 'self': return 'this machine';
    default: return 'not detected';
  }
}

function planText(row: OnboardBalanceRow): string | null {
  if (row.selectedPlanTier) return `plan ${row.selectedPlanTier}`;
  return row.planTiers.length > 0 ? `plans: ${row.planTiers.join(' · ')}` : null;
}

function usageText(usage: OnboardUsageReading | null): string {
  if (!usage) return 'usage unknown';
  const parts: string[] = [];
  if (usage.usedPct !== null) parts.push(`${usage.usedPct}% of window used`);
  if (usage.resetsAt) parts.push(`resets ${usage.resetsAt}`);
  if (usage.callsToday !== null) parts.push(`${usage.callsToday} dispatches today`);
  if (usage.tokensToday !== null) parts.push(`${usage.tokensToday} tokens`);
  if (usage.costTodayUsd !== null) parts.push(`$${usage.costTodayUsd.toFixed(2)}`);
  return parts.length > 0 ? parts.join(', ') : 'usage unknown';
}

export function ConnectView() {
  const [report, setReport] = useState<OnboardStatusReport | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [agentSaveFailed, setAgentSaveFailed] = useState(false);
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    apiGet<OnboardStatusReport>('/api/onboard/status')
      .then((next) => { if (!cancelled) setReport(next); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const byId = new Map((report?.resources ?? []).map((r) => [r.id, r] as const));
  // POST routes only exist on a dispatch-enabled server.
  const picksLocked = report?.dispatchEnabled === false;

  async function refresh() {
    setReport(await apiGet<OnboardStatusReport>('/api/onboard/status'));
  }

  async function pickTier(resourceId: string, planTier: string | null) {
    setSaveFailed(false);
    try {
      await setResourcePlanTier(resourceId, planTier);
      await refresh();
    } catch {
      setSaveFailed(true);
    }
  }

  async function toggleAgent(id: string, enabled: boolean) {
    setAgentSaveFailed(false);
    setToggling((prev) => new Set(prev).add(id));
    try {
      await setScheduledAgentEnabled(id, enabled);
      await refresh();
    } catch {
      setAgentSaveFailed(true);
    } finally {
      setToggling((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const balance = report?.balance ?? null;
  const balanceRows = (balance?.resources ?? [])
    .filter((row) => row.connected || row.selectedPlanTier !== null || row.usage !== null);

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
      {balance && (
        <section className={styles.card} aria-labelledby="connect-balance">
          <h2 id="connect-balance">Resource balance</h2>
          <p>
            {balance.connected.length === 0
              ? 'Nothing connected yet.'
              : `${balance.connected.length} connected: ${balance.connected.map(catalogName).join(', ')}.`}
            {` ${balance.scheduledAgents.enabled}/${balance.scheduledAgents.total} scheduled agents on.`}
          </p>
          <ul>
            {balanceRows.map((row) => (
              <li key={row.id}>
                <span className={styles.badge} aria-hidden="true">{catalogName(row.id).slice(0, 1)}</span>
                <div>
                  <span>{catalogName(row.id)}</span>
                  <small className={styles.status}>{evidenceText(row)}</small>
                  {planText(row) && <small>{planText(row)}</small>}
                  <small>{usageText(row.usage)}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
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
              {step.kind === 'agent' && report?.agents.agents.map((agent) => (
                <li key={agent.id}>
                  <span className={styles.badge} aria-hidden="true">{agent.name.slice(0, 1)}</span>
                  <div>
                    <span>{agent.name}</span>
                    <small>
                      {agent.rrule}
                      {agent.nextRunAt ? ` - next ${agent.nextRunAt}` : ''}
                    </small>
                  </div>
                  <Switch
                    aria-label={`${agent.name} enabled`}
                    checked={agent.enabled}
                    disabled={picksLocked || toggling.has(agent.id)}
                    onChange={(next) => void toggleAgent(agent.id, next)}
                  />
                </li>
              ))}
            </ul>
            {step.kind === 'agent' && report?.agents.agents.length === 0 && (
              <small>No scheduled agents on this computer yet.</small>
            )}
            {step.kind === 'agent' && report && !report.agents.schedulerRunning && report.agents.agents.length > 0 && (
              <small>The local scheduler is not ticking; schedules will not fire until it runs.</small>
            )}
            {step.kind === 'subscription' && saveFailed && (
              <p role="alert" className={styles.notice}>Plan tier was not saved.</p>
            )}
            {step.kind === 'subscription' && picksLocked && !saveFailed && (
              <small>Plan picks save to local config when this server runs with dispatch enabled.</small>
            )}
            {step.kind === 'agent' && agentSaveFailed && (
              <p role="alert" className={styles.notice}>Agent toggle was not saved.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
