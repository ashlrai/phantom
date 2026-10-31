import { RESOURCE_CATALOG, type ResourceKind } from '../../../core/onboard/catalog.js';
import styles from './ConnectView.module.css';

const STEPS: readonly { kind: ResourceKind; title: string; description: string }[] = [
  { kind: 'subscription', title: 'Subscriptions', description: 'Explore coding tools you already use.' },
  { kind: 'apikey', title: 'API keys', description: 'Explore model providers for API access.' },
  { kind: 'local', title: 'Local models', description: 'Run models on your own hardware.' },
  { kind: 'computer', title: 'This computer', description: 'Use the computer running Phantom.' },
  { kind: 'cloud', title: 'Cloud computer', description: 'Explore remote computing resources.' },
  { kind: 'agent', title: 'Proactive agents', description: 'Explore agents that can work with you.' },
];

export function ConnectView() {
  return (
    <div className={styles.page}>
      <h1>Connect Resources</h1>
      <p className={styles.intro}>Explore the resources you can bring to Phantom. This catalog is read-only; connection setup is coming later.</p>
      <div className={styles.grid}>
        {STEPS.map((step, index) => (
          <section className={styles.card} key={step.kind} aria-labelledby={`connect-${step.kind}`}>
            <span className={styles.step}>Step {index + 1}</span>
            <h2 id={`connect-${step.kind}`}>{step.title}</h2>
            <p>{step.description}</p>
            <ul>
              {RESOURCE_CATALOG.filter((resource) => resource.kind === step.kind).map((resource) => (
                <li key={resource.id}>
                  <span className={styles.badge} aria-hidden="true">{resource.displayName.slice(0, 1)}</span>
                  <div><a href={resource.docsUrl}>{resource.displayName}</a>
                    {resource.planTiers.length > 0 && <small>{resource.planTiers.join(' · ')}</small>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
