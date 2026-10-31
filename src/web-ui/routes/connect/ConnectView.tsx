import { useEffect, useId, useState, type FormEvent } from 'react';
import { apiKeyCatalogResources, RESOURCE_CATALOG, type CatalogResource, type ResourceKind } from '../../../core/onboard/catalog.js';
import { useMutationHold, useQuery } from '../../data/hooks.js';
import { connectKeysQuery } from '../../data/queries.js';
import { connectApiKey, type ConnectApiKeyResult } from '../../data/mutations.js';
import { readFailureReason } from '../../data/client.js';
import { isRemoteMobileMode } from '../../data/remote-mode.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import styles from './ConnectView.module.css';

const STEPS: readonly { kind: ResourceKind; title: string; description: string }[] = [
  { kind: 'subscription', title: 'Subscriptions', description: 'Explore coding tools you already use.' },
  { kind: 'apikey', title: 'API keys', description: 'Store model provider keys in Phantom Secrets.' },
  { kind: 'local', title: 'Local models', description: 'Run models on your own hardware.' },
  { kind: 'computer', title: 'This computer', description: 'Use the computer running Phantom.' },
  { kind: 'cloud', title: 'Cloud computer', description: 'Explore remote computing resources.' },
  { kind: 'agent', title: 'Proactive agents', description: 'Explore agents that can work with you.' },
];

interface ApiKeyFormProps {
  resource: CatalogResource;
  stored: boolean;
  busy: boolean;
  result?: ConnectApiKeyResult;
  error?: string;
  onSubmit: (resource: string, value: string) => void;
}

// Key entry for one provider. The field clears only once the key is stored;
// nothing here ever renders the submitted value -- the only echo is the
// server's masked last-4 plus the validation verdict.
function ApiKeyForm({ resource, stored, busy, result, error, onSubmit }: ApiKeyFormProps) {
  const inputId = useId();
  const [value, setValue] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (v && !busy) onSubmit(resource.id, v);
  }

  useEffect(() => { if (result?.stored) setValue(''); }, [result]);

  return (
    <form className={styles.keyForm} onSubmit={submit} aria-label={`Store ${resource.displayName} API key`}>
      <label className={styles.srOnly} htmlFor={inputId}>{resource.displayName} API key</label>
      <input
        id={inputId}
        className={styles.keyInput}
        type="password"
        autoComplete="off"
        placeholder={stored ? 'Paste a key to replace' : 'Paste API key'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      <button type="submit" className={styles.keyButton} disabled={busy || value.trim().length === 0}>
        {busy ? 'Storing' : stored ? 'Replace' : 'Store'}
      </button>
      <div className={styles.keyStatus} aria-live="polite">
        {stored ? <span className={styles.storedTag}>in vault</span> : null}
        {result ? <span className={styles.keyResult}><code>{result.masked}</code>{' '}
          {result.validated === true
            ? <span className={styles.ok}>validated</span>
            : result.validated === false
              ? <span className={styles.bad}>rejected by provider</span>
              : <span className={styles.muted}>stored; validation unavailable</span>}
        </span> : null}
        {error ? <span className={styles.keyError} role="alert">{error}</span> : null}
      </div>
    </form>
  );
}

export function ConnectView() {
  // Remote/gateway sessions never render key entry: the hub API behind it
  // exists on loopback only, so the form is withheld rather than left to fail.
  const remote = isRemoteMobileMode();
  const keysQuery = useQuery(connectKeysQuery, { enabled: !remote });
  const mutationHold = useMutationHold();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [pending, setPending] = useState<{ resource: string; value: string } | null>(null);
  const [busyResource, setBusyResource] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectApiKeyResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const storedByResource = new Map((keysQuery.data?.keys ?? []).map((k) => [k.resource, k.stored]));

  async function submitKey(resource: string, value: string) {
    setBusyResource(resource);
    try {
      const result = await connectApiKey(resource, value);
      setResults((r) => ({ ...r, [resource]: result }));
      setErrors((e) => ({ ...e, [resource]: '' }));
    } catch (err) {
      setErrors((e) => ({ ...e, [resource]: readFailureReason(err) }));
    } finally {
      setBusyResource(null);
    }
  }

  function requestKey(resource: string, value: string) {
    if (mutationHold.hasHold) void submitKey(resource, value);
    else { setPending({ resource, value }); setTokenOpen(true); }
  }

  // Mirror FleetView: once the token dialog closes, run the pending submit
  // only when a hold now exists; otherwise drop it so the plaintext does not
  // linger in state.
  useEffect(() => {
    if (tokenOpen || !pending) return;
    const next = pending;
    setPending(null);
    if (mutationHold.hasHold) void submitKey(next.resource, next.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on tokenOpen transitioning closed.
  }, [tokenOpen]);

  return (
    <div className={styles.page}>
      <h1>Connect Resources</h1>
      <p className={styles.intro}>
        Explore the resources you can bring to Phantom. API keys are written straight into Phantom
        Secrets from this local console; only a masked form and a validation verdict come back.
      </p>
      <div className={styles.grid}>
        {STEPS.map((step, index) => (
          <section className={styles.card} key={step.kind} aria-labelledby={`connect-${step.kind}`}>
            <span className={styles.step}>Step {index + 1}</span>
            <h2 id={`connect-${step.kind}`}>{step.title}</h2>
            <p>{step.description}</p>
            <ul>
              {(step.kind === 'apikey'
                ? apiKeyCatalogResources()
                : RESOURCE_CATALOG.filter((resource) => resource.kind === step.kind)
              ).map((resource) => (
                <li key={resource.id}>
                  <span className={styles.badge} aria-hidden="true">{resource.displayName.slice(0, 1)}</span>
                  <div className={styles.keyBody}>
                    <a href={resource.docsUrl}>{resource.displayName}</a>
                    {resource.planTiers.length > 0 && <small>{resource.planTiers.join(' · ')}</small>}
                    {step.kind === 'apikey' ? (
                      remote ? (
                        <small className={styles.localOnly}>Key entry is only available in the local console on this computer.</small>
                      ) : (
                        <ApiKeyForm
                          resource={resource}
                          stored={storedByResource.get(resource.id) ?? false}
                          busy={busyResource === resource.id}
                          result={results[resource.id]}
                          error={errors[resource.id]}
                          onSubmit={requestKey}
                        />
                      )
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <MutationTokenDialog
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        reason="Storing an API key writes to the Phantom Secrets vault and requires the dispatch token."
      />
    </div>
  );
}
