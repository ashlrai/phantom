/**
 * core/onboarding/resources-model.ts — what the setup wizard knows about the
 * resources a user connects, and where each credential would live.
 *
 * Pure: no I/O. VALUE-BLIND BY CONSTRUCTION: a `ResourceEntry` carries a
 * label, a kind, a scope and a credential *reference* — there is no field for
 * a secret value, and `assertNoSecretValue` rejects anything that looks like
 * one, so a key pasted into the label box never reaches storage or a model.
 *
 * Works with ZERO companions: one Claude Code account and nothing else is a
 * complete, valid setup. Secrets and Locus only change where a credential is
 * stored and whether a scope is enforced.
 */
import type { CompanionId } from '../ecosystem/companion-manifest.js';

export type ResourceKind =
  | 'claude-code'
  | 'codex'
  | 'grok'
  | 'devin'
  | 'ollama'
  | 'lm-studio'
  | 'api-key'
  | 'cloud-credits';

export type ResourceScope = 'personal' | 'company' | 'client';

export interface ResourceKindMeta {
  kind: ResourceKind;
  label: string;
  /** Subscription seat, local runtime, or a keyed credential. */
  family: 'subscription' | 'local' | 'credential';
  /** How the user signs in. Shown, never run by the wizard. */
  connect: string;
  /** True when connecting requires a stored secret (API key, credit token). */
  needsSecret: boolean;
  /** Multiple accounts of this kind are expected (e.g. several Codex seats). */
  multi: boolean;
}

export const RESOURCE_KINDS: readonly ResourceKindMeta[] = [
  { kind: 'claude-code', label: 'Claude Code', family: 'subscription', connect: 'claude login', needsSecret: false, multi: true },
  { kind: 'codex', label: 'Codex', family: 'subscription', connect: 'codex login', needsSecret: false, multi: true },
  { kind: 'grok', label: 'Grok', family: 'subscription', connect: 'grok login (or an xAI API key)', needsSecret: false, multi: true },
  { kind: 'devin', label: 'Devin', family: 'subscription', connect: 'phm devin connect', needsSecret: true, multi: true },
  { kind: 'ollama', label: 'Ollama (local)', family: 'local', connect: 'ollama serve', needsSecret: false, multi: false },
  { kind: 'lm-studio', label: 'LM Studio (local)', family: 'local', connect: 'Start the LM Studio server', needsSecret: false, multi: false },
  { kind: 'api-key', label: 'API key / credits', family: 'credential', connect: 'Stored by name; you paste the value in a trusted terminal', needsSecret: true, multi: true },
  { kind: 'cloud-credits', label: 'Cloud credits', family: 'credential', connect: 'Stored by name; you paste the value in a trusted terminal', needsSecret: true, multi: true },
];

export const RESOURCE_SCOPES: readonly ResourceScope[] = ['personal', 'company', 'client'];

export interface ResourceEntry {
  id: string;
  kind: ResourceKind;
  /** Human label, e.g. "Codex — client: Acme". Never a secret. */
  label: string;
  scope: ResourceScope;
  /** For `client` scope: which client. */
  scopeName: string | null;
  /** Env-style credential name, e.g. OPENAI_API_KEY_ACME. Reference only. */
  credentialName: string | null;
}

export function kindMeta(kind: ResourceKind): ResourceKindMeta {
  return RESOURCE_KINDS.find((k) => k.kind === kind)!;
}

// ---------------------------------------------------------------------------
// Value-blind guard
// ---------------------------------------------------------------------------

/** Shapes that are almost certainly secret values, not names. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style
  /\bxai-[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Fa-f0-9]{40,}\b/, // long hex
  /\b[A-Za-z0-9+/]{48,}={0,2}/, // long base64-ish blob
];

export function looksLikeSecretValue(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

/** Replace anything secret-shaped with a marker. phm_ references are kept. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (m) =>
      m.startsWith('phm_') ? m : '[redacted]',
    );
  }
  return out;
}

const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface EntryValidation {
  ok: boolean;
  errors: string[];
}

export function validateEntry(entry: ResourceEntry): EntryValidation {
  const errors: string[] = [];
  if (!entry.label.trim()) errors.push('Give the resource a label.');
  for (const [field, value] of [['label', entry.label], ['client name', entry.scopeName ?? ''], ['credential name', entry.credentialName ?? '']] as const) {
    if (value && looksLikeSecretValue(value)) {
      errors.push(`The ${field} looks like a secret value. Enter a name only — the value is entered later in a trusted terminal.`);
    }
  }
  if (entry.scope === 'client' && !entry.scopeName?.trim()) errors.push('Name the client for a client-scoped resource.');
  const meta = kindMeta(entry.kind);
  if (meta.needsSecret) {
    if (!entry.credentialName) errors.push('Name the credential (e.g. OPENAI_API_KEY).');
    else if (!CREDENTIAL_NAME.test(entry.credentialName)) errors.push('Credential names use UPPER_SNAKE_CASE, e.g. OPENAI_API_KEY_ACME.');
  }
  return { ok: errors.length === 0, errors };
}

/** Suggest an UPPER_SNAKE credential name from a label + scope. */
export function suggestCredentialName(kind: ResourceKind, scope: ResourceScope, scopeName: string | null): string {
  const base: Record<ResourceKind, string> = {
    'claude-code': 'ANTHROPIC_API_KEY',
    codex: 'OPENAI_API_KEY',
    grok: 'XAI_API_KEY',
    devin: 'DEVIN_API_KEY',
    ollama: 'OLLAMA_HOST',
    'lm-studio': 'LMSTUDIO_HOST',
    'api-key': 'API_KEY',
    'cloud-credits': 'CLOUD_CREDITS_TOKEN',
  };
  const suffix = scope === 'client' && scopeName ? `_${scopeName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}` : scope === 'company' ? '_COMPANY' : '';
  return `${base[kind]}${suffix}`.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Storage + scope plan
// ---------------------------------------------------------------------------

export type CredentialStore = 'phantom-secrets' | 'os-keychain' | 'none';
export type ScopeBinding = 'locus' | 'label-only';

export interface ResourcePlan {
  entry: ResourceEntry;
  store: CredentialStore;
  binding: ScopeBinding;
  /** Commands the USER runs in a trusted terminal. The value is never an argument. */
  steps: string[];
  /** The only thing a model/assistant may see for this credential. */
  modelReference: string | null;
}

function keychainCommand(name: string): string {
  // Interactive prompts for the value (-w with no argument) — never on argv.
  return `security add-generic-password -a "$USER" -s phantom.${name} -w   # macOS; on Linux: secret-tool store --label=${name} service phantom.${name}`;
}

export function planResource(entry: ResourceEntry, companions: ReadonlySet<CompanionId>): ResourcePlan {
  const meta = kindMeta(entry.kind);
  const secrets = companions.has('phantom-secrets');
  const locus = companions.has('locus');
  const steps: string[] = [];
  let store: CredentialStore = 'none';
  let modelReference: string | null = null;

  if (meta.family === 'subscription' || meta.family === 'local') steps.push(meta.connect);
  if (meta.needsSecret && entry.credentialName) {
    if (secrets) {
      store = 'phantom-secrets';
      steps.push('phantom init --empty   # once per project, if it has no vault yet');
      steps.push(`phantom add ${entry.credentialName}   # hidden prompt for the value; agents only see a phm_ token`);
      modelReference = `phm:${entry.credentialName}`;
    } else {
      store = 'os-keychain';
      steps.push(keychainCommand(entry.credentialName));
      modelReference = `keychain:phantom.${entry.credentialName}`;
    }
  }
  const binding: ScopeBinding = locus ? 'locus' : 'label-only';
  if (locus) {
    const ws = entry.scope === 'client' ? `client-${(entry.scopeName ?? 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : entry.scope;
    steps.push(`locus enter ${ws}   # bind ${meta.label} sign-ins to the ${ws} workspace`);
  }
  return { entry, store, binding, steps, modelReference };
}

export interface SetupSummary {
  resourceCount: number;
  /** The minimum viable setup: at least one subscription seat or local runtime or keyed provider. */
  usable: boolean;
  byScope: Record<ResourceScope, number>;
  storedInSecrets: number;
  storedInKeychain: number;
}

export function summarise(plans: readonly ResourcePlan[]): SetupSummary {
  const byScope: Record<ResourceScope, number> = { personal: 0, company: 0, client: 0 };
  for (const p of plans) byScope[p.entry.scope] += 1;
  return {
    resourceCount: plans.length,
    usable: plans.length > 0,
    byScope,
    storedInSecrets: plans.filter((p) => p.store === 'phantom-secrets').length,
    storedInKeychain: plans.filter((p) => p.store === 'os-keychain').length,
  };
}
