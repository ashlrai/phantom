/**
 * routes/verse/setup/SetupWizard.tsx — the workbench setup wizard.
 *
 * Design rules (docs/design-principles.md): ONE primary button per screen,
 * everything else quiet; smart defaults so most people just press Continue
 * (all companions on, seats Phantom already sees pre-filled); details behind
 * disclosure; Back and Skip always present; keyboard-first (Enter continues,
 * Alt+← goes back, Esc closes).
 *
 * Value-blind: no field accepts a secret value. Credentials are named here
 * and typed later by the user in a trusted terminal (phantom add / keychain).
 * Nothing is installed, starred, signed in or executed from this dialog.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, Select, Switch } from '../../../components/primitives/index.js';
import { IconCheckCircle, IconCopy, IconExternalLink, IconInfo, IconPlus, IconTrash } from '../../../components/primitives/icons.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { useQuery } from '../../../data/hooks.js';
import { verseHealthQuery } from '../health/health-queries.js';
import { requestVerseCommand } from '../verse-ui-store.js';
import {
  COMPANION_MANIFEST,
  repoUrl,
  selectedIds,
  type CompanionEntry,
  type CompanionId,
} from '../../../../core/ecosystem/companion-manifest.js';
import {
  RESOURCE_KINDS,
  RESOURCE_SCOPES,
  kindMeta,
  planResource,
  suggestCredentialName,
  validateEntry,
  type ResourceEntry,
  type ResourceKind,
  type ResourceScope,
} from '../../../../core/onboarding/resources-model.js';
import { buildAssistantBrief, buildProposals } from '../../../../core/onboarding/setup-assistant.js';
import {
  addResource,
  closeSetupWizard,
  completeSetupWizard,
  decide,
  removeResource,
  setSetupStep,
  toggleCompanion,
} from './setup-wizard-store.js';
import { SETUP_STEPS, entriesFromSeats, tallySeats } from './setup-wizard-model.js';
import { useSetupWizard } from './useSetupWizard.js';
import psLogo from '../../../assets/companions/phantom-secrets.svg';
import lexLogo from '../../../assets/companions/lexicon.svg';
import mdLogo from '../../../assets/companions/ashlr-md.png';
import stackLogo from '../../../assets/companions/ashlr-stack.svg';
import pluginLogo from '../../../assets/companions/ashlr-plugin.svg';
import binLogo from '../../../assets/companions/binshield.svg';
import styles from './setup-wizard.module.css';

const LOGOS: Record<string, string> = {
  'phantom-secrets.svg': psLogo,
  'lexicon.svg': lexLogo,
  'ashlr-md.png': mdLogo,
  'ashlr-stack.svg': stackLogo,
  'ashlr-plugin.svg': pluginLogo,
  'binshield.svg': binLogo,
};

function CompanionMark({ entry, size = 32 }: { entry: CompanionEntry; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = entry.logo ? LOGOS[entry.logo] : undefined;
  if (src && !broken) {
    return <img className={styles.logo} src={src} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  }
  return (
    <span className={styles.monogram} aria-hidden="true" style={{ width: size, height: size, ['--mono-hue' as string]: String(entry.hue) }}>
      {entry.monogram}
    </span>
  );
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------- step 1

function CompanionsStep({ selection }: { selection: Record<CompanionId, boolean> }) {
  const [openId, setOpenId] = useState<CompanionId | null>(null);
  const heroes = COMPANION_MANIFEST.filter((c) => c.tier === 'hero');
  const extras = COMPANION_MANIFEST.filter((c) => c.tier === 'extra');
  const row = (c: CompanionEntry) => {
    const expanded = openId === c.id;
    return (
      <li key={c.id} className={c.tier === 'hero' ? styles.heroCard : styles.extraRow} data-selected={selection[c.id]}>
        <div className={styles.cardHead}>
          <CompanionMark entry={c} size={c.tier === 'hero' ? 36 : 24} />
          <button
            type="button"
            className={styles.cardText}
            aria-expanded={expanded}
            aria-controls={`companion-${c.id}`}
            onClick={() => setOpenId(expanded ? null : c.id)}
          >
            <span className={styles.cardTitle}>{c.title}</span>
            <span className={styles.cardTagline}>{c.tagline}</span>
          </button>
          <Switch checked={selection[c.id]} onChange={(on) => toggleCompanion(c.id, on)} aria-label={`Include ${c.title}`} />
        </div>
        {expanded ? (
          <div id={`companion-${c.id}`} className={styles.details}>
            {c.details.map((d) => <p key={d}>{d}</p>)}
            <p className={styles.mono}>{c.install}</p>
            <div className={styles.quietActions}>
              <Button variant="ghost" size="sm" icon={<IconExternalLink size={13} />} onClick={() => openExternal(repoUrl(c))}>
                View on GitHub
              </Button>
              {/* Opens the repo page, where the user stars it themselves — never automated. */}
              <Button variant="ghost" size="sm" onClick={() => openExternal(repoUrl(c))} aria-label={`Star ${c.title} on GitHub`}>
                ★ Star
              </Button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };
  return (
    <div className={styles.body}>
      <ul className={styles.heroList}>{heroes.map(row)}</ul>
      <p className={styles.groupLabel}>Extras</p>
      <ul className={styles.extraList}>{extras.map(row)}</ul>
      <p className={styles.aside}>Phantom works with none of these. Selecting one never installs it — the plan shows how.</p>
    </div>
  );
}

// ---------------------------------------------------------------- step 2

function ResourceForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<ResourceKind>('api-key');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<ResourceScope>('personal');
  const [scopeName, setScopeName] = useState('');
  const [credentialName, setCredentialName] = useState('');
  const meta = kindMeta(kind);
  const entry: ResourceEntry = {
    id: `res:${kind}:${Date.now().toString(36)}`,
    kind,
    label: label || meta.label,
    scope,
    scopeName: scope === 'client' ? scopeName : null,
    credentialName: meta.needsSecret ? credentialName || suggestCredentialName(kind, scope, scopeName || null) : null,
  };
  const v = validateEntry(entry);
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.ok) return;
        addResource(entry);
        onDone();
      }}
    >
      <Select label="Type" size="sm" value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)}>
        {RESOURCE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </Select>
      <Input label="Label" size="sm" placeholder={meta.label} value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
      <Select label="Scope" size="sm" value={scope} onChange={(e) => setScope(e.target.value as ResourceScope)}>
        {RESOURCE_SCOPES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
      </Select>
      {scope === 'client' ? <Input label="Client" size="sm" value={scopeName} onChange={(e) => setScopeName(e.target.value)} autoComplete="off" /> : null}
      {meta.needsSecret ? (
        <Input
          label="Credential name"
          size="sm"
          hint="A name only. You type the value later in a hidden terminal prompt."
          placeholder={suggestCredentialName(kind, scope, scopeName || null)}
          value={credentialName}
          onChange={(e) => setCredentialName(e.target.value.toUpperCase())}
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}
      {!v.ok && (label || credentialName || scopeName) ? <p className={styles.error} role="alert">{v.errors[0]}</p> : null}
      <div className={styles.quietActions}>
        <Button type="submit" variant="subtle" size="sm" disabled={!v.ok}>Add</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ResourcesStep({ resources, enabled }: { resources: ResourceEntry[]; enabled: ReadonlySet<CompanionId> }) {
  const [adding, setAdding] = useState(false);
  const store = enabled.has('phantom-secrets') ? 'Phantom Secrets' : 'your OS keychain';
  const scopes = enabled.has('locus') ? 'Locus keeps each scope’s accounts apart' : 'scopes are labels (turn on Locus to enforce them)';
  return (
    <div className={styles.body}>
      {resources.length === 0 ? (
        <p className={styles.lead}>No accounts found yet. Add one — a single Claude Code login is a complete setup.</p>
      ) : (
        <ul className={styles.resourceList} aria-label="Resources">
          {resources.map((r) => (
            <li key={r.id} className={styles.resourceRow}>
              <IconCheckCircle size={14} aria-hidden="true" />
              <span className={styles.resourceLabel}>{r.label}</span>
              <span className={styles.tag}>{r.scope}{r.scopeName ? `: ${r.scopeName}` : ''}</span>
              {r.credentialName ? <code className={styles.mono}>{r.credentialName}</code> : null}
              <Button iconOnly variant="ghost" size="sm" aria-label={`Remove ${r.label}`} icon={<IconTrash size={13} />} onClick={() => removeResource(r.id)} />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <ResourceForm onDone={() => setAdding(false)} />
      ) : (
        <Button variant="ghost" size="sm" icon={<IconPlus size={13} />} onClick={() => setAdding(true)}>
          Add an account, API key or credits
        </Button>
      )}
      <p className={styles.aside}>Keys are stored in {store}; {scopes}.</p>
    </div>
  );
}

// ---------------------------------------------------------------- step 3

function AssistantStep({ resources, enabled, decisions }: { resources: ResourceEntry[]; enabled: ReadonlySet<CompanionId>; decisions: Record<string, string> }) {
  const plans = useMemo(() => resources.map((r) => planResource(r, enabled)), [resources, enabled]);
  const proposals = useMemo(() => buildProposals(enabled, plans), [enabled, plans]);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => void copyText(text).then((ok) => setCopied(ok ? key : null));
  const done = proposals.filter((p) => decisions[p.id] === 'confirmed').length;
  return (
    <div className={styles.body}>
      <p className={styles.progressNote} aria-live="polite">{done} of {proposals.length} done</p>
      <ol className={styles.planList}>
        {proposals.map((p) => {
          const d = decisions[p.id] ?? 'pending';
          return (
            <li key={p.id} className={styles.planRow} data-decision={d}>
              <div className={styles.planText}>
                <span className={styles.cardTitle}>{p.title}</span>
                <details>
                  <summary className={styles.summary}>How</summary>
                  <p className={styles.cardTagline}>{p.why}</p>
                  <code className={styles.mono}>{p.command}</code>
                </details>
              </div>
              <div className={styles.quietActions}>
                <Button variant="ghost" size="sm" icon={<IconCopy size={12} />} aria-label={`Copy command: ${p.title}`} onClick={() => copy(p.id, p.command)}>
                  {copied === p.id ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" size="sm" aria-pressed={d === 'confirmed'} onClick={() => decide(p.id, d === 'confirmed' ? 'pending' : 'confirmed')}>
                  {d === 'confirmed' ? 'Done ✓' : 'Mark done'}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <details className={styles.disclosure}>
        <summary className={styles.summary}>Get help from an assistant</summary>
        <p className={styles.cardTagline}>
          Copy a plan brief (names and phm_ references only — never a key) and paste it into a new chat on a local model or any connected seat. It proposes one step at a time; you confirm each.
        </p>
        <div className={styles.quietActions}>
          <Button variant="ghost" size="sm" icon={<IconCopy size={12} />} onClick={() => copy('brief', buildAssistantBrief(enabled, plans, proposals))}>
            {copied === 'brief' ? 'Brief copied' : 'Copy brief'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => requestVerseCommand('new-chat')}>Open a chat</Button>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- step 4

const CONTEXT_SOURCES = [
  { id: 'claude-global', label: 'Claude Code memory', path: '~/.claude/CLAUDE.md' },
  { id: 'codex-agents', label: 'Codex instructions', path: '~/.codex/AGENTS.md' },
  { id: 'codex-config', label: 'Codex models & MCP servers', path: '~/.codex/config.toml' },
  { id: 'grok-instructions', label: 'Grok CLI settings', path: '~/.grok/user-settings.json' },
];

function ContextStep() {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.body}>
      <p className={styles.lead}>Nothing is read unless you ask. Each import shows a preview first, and secret-looking text is redacted.</p>
      <ul className={styles.resourceList}>
        {CONTEXT_SOURCES.map((s) => (
          <li key={s.id} className={styles.resourceRow}>
            <IconInfo size={14} aria-hidden="true" />
            <span className={styles.resourceLabel}>{s.label}</span>
            <code className={styles.mono}>{s.path}</code>
          </li>
        ))}
      </ul>
      <details className={styles.disclosure}>
        <summary className={styles.summary}>Preview and import from a terminal</summary>
        <code className={styles.mono}>phm setup workbench context</code>
        <div className={styles.quietActions}>
          <Button variant="ghost" size="sm" icon={<IconCopy size={12} />} onClick={() => void copyText('phm setup workbench context').then(setCopied)}>
            {copied ? 'Copied' : 'Copy command'}
          </Button>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- step 5

function FinishStep({ enabled, resources }: { enabled: ReadonlySet<CompanionId>; resources: ResourceEntry[] }) {
  const health = useQuery(verseHealthQuery);
  const tally = tallySeats(health.data?.seats);
  return (
    <div className={styles.body}>
      <ul className={styles.resourceList}>
        <li className={styles.resourceRow}>
          <IconCheckCircle size={14} aria-hidden="true" />
          <span className={styles.resourceLabel}>{enabled.size} companion{enabled.size === 1 ? '' : 's'} selected</span>
        </li>
        <li className={styles.resourceRow}>
          <IconCheckCircle size={14} aria-hidden="true" />
          <span className={styles.resourceLabel}>{resources.length} resource{resources.length === 1 ? '' : 's'} planned</span>
        </li>
        <li className={styles.resourceRow} aria-live="polite">
          {tally ? <IconCheckCircle size={14} aria-hidden="true" /> : <IconInfo size={14} aria-hidden="true" />}
          <span className={styles.resourceLabel}>
            {tally
              ? `Seats: ${tally.connected} connected${tally.attention ? `, ${tally.attention} need attention` : ''}${tally.unknown ? `, ${tally.unknown} not reported` : ''}`
              : health.status === 'error' ? 'Seat health not reported by this server' : 'Checking seats…'}
          </span>
        </li>
      </ul>
      <details className={styles.disclosure}>
        <summary className={styles.summary}>Full health check</summary>
        <code className={styles.mono}>phm setup workbench health</code>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- shell

export function SetupWizard() {
  const s = useSetupWizard();
  const index = Math.min(SETUP_STEPS.length - 1, s.step);
  const meta = SETUP_STEPS[index]!;
  const enabled = useMemo(() => new Set(selectedIds(s.companions)), [s.companions]);
  const health = useQuery(verseHealthQuery);

  // Smart default: seats Phantom already sees appear as resources.
  useEffect(() => {
    for (const e of entriesFromSeats(health.data?.seats, s.resources)) addResource(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.data]);

  const last = index === SETUP_STEPS.length - 1;
  const next = () => (last ? completeSetupWizard() : setSetupStep(index + 1));
  const back = () => setSetupStep(index - 1);

  // Keyboard-first, on the document so it survives focus moving with each step.
  useEffect(() => {
    if (!s.open) return undefined;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? '';
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY', 'A'].includes(tag)) {
        e.preventDefault();
        next();
      } else if (e.altKey && e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        back();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <Dialog open={s.open} onClose={closeSetupWizard} titleId="setup-wizard-title" title={meta.title} description={meta.subtitle} widthClassName={styles.dialog}>
      <div className={styles.wizard}>
        <nav aria-label="Setup progress" className={styles.progress}>
          <ol>
            {SETUP_STEPS.map((step, i) => (
              <li key={step.id} data-state={i === index ? 'current' : i < index ? 'done' : 'todo'} aria-current={i === index ? 'step' : undefined}>
                <span className={styles.srOnly}>{`Step ${i + 1} of ${SETUP_STEPS.length}: ${step.title}`}</span>
              </li>
            ))}
          </ol>
          <span className={styles.progressNote}>{index + 1} / {SETUP_STEPS.length}</span>
        </nav>

        {meta.id === 'companions' ? <CompanionsStep selection={s.companions} /> : null}
        {meta.id === 'resources' ? <ResourcesStep resources={s.resources} enabled={enabled} /> : null}
        {meta.id === 'assistant' ? <AssistantStep resources={s.resources} enabled={enabled} decisions={s.decisions} /> : null}
        {meta.id === 'context' ? <ContextStep /> : null}
        {meta.id === 'finish' ? <FinishStep enabled={enabled} resources={s.resources} /> : null}

        <footer className={styles.foot}>
          <Button variant="ghost" size="sm" onClick={closeSetupWizard}>Skip for now</Button>
          <div className={styles.footRight}>
            {index > 0 ? <Button variant="ghost" size="sm" onClick={back}>Back</Button> : null}
            <Button variant="primary" size="sm" onClick={next} autoFocus>{meta.primary}</Button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}

export default SetupWizard;
