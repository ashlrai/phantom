/**
 * core/onboarding/setup-assistant.ts — the AI-guided setup step's contract.
 *
 * The assistant PROPOSES; the user CONFIRMS each action. This module builds
 * (a) the deterministic proposal list from the wizard's choices and
 * (b) the brief handed to whichever model runs the conversation — a local
 * model or a just-connected subscription.
 *
 * SECRET VALUES NEVER REACH THE MODEL: the brief is built only from labels,
 * kinds, scopes and credential REFERENCES (`phm:NAME` / `keychain:…`), and
 * the final text passes through `redactSecrets` as a second line of defence.
 */
import { COMPANION_MANIFEST, type CompanionId } from '../ecosystem/companion-manifest.js';
import { kindMeta, redactSecrets, type ResourcePlan } from './resources-model.js';

export type ProposalKind = 'install-companion' | 'connect-resource' | 'store-credential' | 'bind-scope' | 'register-mcp' | 'verify';

export interface SetupProposal {
  id: string;
  kind: ProposalKind;
  /** Plain-language title, e.g. "Store OPENAI_API_KEY in Phantom Secrets". */
  title: string;
  /** Why, in one sentence. */
  why: string;
  /** The command the user runs (copied, never auto-executed by the model). */
  command: string;
}

export type ProposalDecision = 'pending' | 'confirmed' | 'skipped';

export function buildProposals(companions: ReadonlySet<CompanionId>, plans: readonly ResourcePlan[], installed: ReadonlySet<CompanionId> = new Set()): SetupProposal[] {
  const out: SetupProposal[] = [];
  for (const c of COMPANION_MANIFEST) {
    if (!companions.has(c.id) || installed.has(c.id)) continue;
    out.push({ id: `install:${c.id}`, kind: 'install-companion', title: `Install ${c.title}`, why: c.tagline, command: c.install });
  }
  for (const p of plans) {
    const meta = kindMeta(p.entry.kind);
    p.steps.forEach((step, i) => {
      const kind: ProposalKind = step.startsWith('phantom') || step.startsWith('security') ? 'store-credential' : step.startsWith('locus') ? 'bind-scope' : 'connect-resource';
      out.push({
        id: `res:${p.entry.id}:${i}`,
        kind,
        title: kind === 'store-credential'
          ? `Store ${p.entry.credentialName} ${p.store === 'phantom-secrets' ? 'in Phantom Secrets' : 'in the OS keychain'}`
          : kind === 'bind-scope' ? `Bind ${p.entry.label} to its ${p.entry.scope} scope` : `Connect ${p.entry.label} (${meta.label})`,
        why: kind === 'store-credential' ? 'You type the value in a hidden terminal prompt; Phantom and the assistant only see a reference.'
          : kind === 'bind-scope' ? 'Keeps personal, company and client accounts from crossing.' : 'Signs this account in so Phantom can route work to it.',
        command: step.replace(/\s+#.*$/, ''),
      });
    });
  }
  if (companions.has('phantom-secrets') || companions.has('locus') || companions.has('lexicon')) {
    out.push({ id: 'mcp:ecosystem', kind: 'register-mcp', title: 'Register companion MCP servers', why: 'Gives Claude Code, Codex and Phantom chats the companions’ tools.', command: 'phm mcp ecosystem --write' });
  }
  out.push({ id: 'verify', kind: 'verify', title: 'Run the health check', why: 'Confirms every seat, runtime and companion answers.', command: 'phm setup workbench health' });
  return out;
}

export const ASSISTANT_SYSTEM_PROMPT = [
  'You are Phantom’s setup assistant. Help the user connect resources, register MCP servers, sign in CLIs and organise credentials by personal, company and client scope.',
  'Rules: propose one action at a time and wait for the user to confirm it. Never ask for, repeat or guess a secret value.',
  'Credentials appear only as references such as phm:NAME or keychain:phantom.NAME. Values are typed by the user in a trusted terminal, never in chat.',
  'Prefer the commands in the plan. Keep answers short and plain.',
].join('\n');

/** The model-facing brief. Contains no secret values by construction. */
export function buildAssistantBrief(companions: ReadonlySet<CompanionId>, plans: readonly ResourcePlan[], proposals: readonly SetupProposal[]): string {
  const lines: string[] = ['# Phantom setup plan', '', '## Companions enabled'];
  const enabled = COMPANION_MANIFEST.filter((c) => companions.has(c.id));
  lines.push(enabled.length ? enabled.map((c) => `- ${c.title}`).join('\n') : '- none (Phantom alone)');
  lines.push('', '## Resources');
  if (!plans.length) lines.push('- none yet');
  for (const p of plans) {
    lines.push(`- ${p.entry.label} · ${kindMeta(p.entry.kind).label} · ${p.entry.scope}${p.entry.scopeName ? `:${p.entry.scopeName}` : ''}${p.modelReference ? ` · credential ${p.modelReference}` : ''}`);
  }
  lines.push('', '## Proposed actions (user confirms each)');
  proposals.forEach((p, i) => lines.push(`${i + 1}. ${p.title} — \`${p.command}\``));
  return redactSecrets(lines.join('\n'));
}
