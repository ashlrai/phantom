import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPANION_MANIFEST,
  applyExclusions,
  defaultCompanionSelection,
  normaliseSelection,
  selectedIds,
} from '../src/core/ecosystem/companion-manifest.js';
import {
  looksLikeSecretValue,
  planResource,
  redactSecrets,
  summarise,
  validateEntry,
  type ResourceEntry,
} from '../src/core/onboarding/resources-model.js';
import { buildAssistantBrief, buildProposals } from '../src/core/onboarding/setup-assistant.js';
import { discoverContextSources, importSource, previewSource } from '../src/core/onboarding/context-import.js';
import { onPath } from '../src/core/onboarding/detect.js';

const FAKE_KEY = 'sk-' + 'a'.repeat(40);
const claude: ResourceEntry = { id: 'c1', kind: 'claude-code', label: 'Claude Code', scope: 'personal', scopeName: null, credentialName: null };
const acmeKey: ResourceEntry = { id: 'k1', kind: 'api-key', label: 'OpenAI (Acme)', scope: 'client', scopeName: 'Acme', credentialName: 'OPENAI_API_KEY_ACME' };

describe('companion manifest', () => {
  it('lists every companion once, heroes first, all selected by default', () => {
    const ids = COMPANION_MANIFEST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin', 'binshield']));
    expect(COMPANION_MANIFEST.filter((c) => c.tier === 'hero').map((c) => c.id)).toEqual(['phantom-secrets', 'locus']);
    expect(selectedIds(defaultCompanionSelection())).toEqual(ids);
    for (const c of COMPANION_MANIFEST) {
      expect(c.repo).toMatch(/^ashlrai\//);
      expect(c.monogram.length).toBe(2);
      expect(c.details.length).toBeGreaterThan(0);
    }
  });

  it('normalises stored selections and parses exclusions', () => {
    expect(normaliseSelection({ locus: false, bogus: true }).locus).toBe(false);
    expect(normaliseSelection('nope')['phantom-secrets']).toBe(true);
    const { selection, unknown } = applyExclusions('lexicon, nope');
    expect(selection.lexicon).toBe(false);
    expect(unknown).toEqual(['nope']);
  });
});

describe('resources model (value-blind)', () => {
  it('a single Claude Code account with zero companions is a usable setup', () => {
    const plan = planResource(claude, new Set());
    expect(plan.store).toBe('none');
    expect(plan.binding).toBe('label-only');
    expect(summarise([plan]).usable).toBe(true);
  });

  it('stores credentials in Secrets when enabled, keychain otherwise, and binds via Locus', () => {
    const withAll = planResource(acmeKey, new Set(['phantom-secrets', 'locus'] as const));
    expect(withAll.store).toBe('phantom-secrets');
    expect(withAll.modelReference).toBe('phm:OPENAI_API_KEY_ACME');
    expect(withAll.steps.join('\n')).toContain('phantom add OPENAI_API_KEY_ACME');
    expect(withAll.steps.join('\n')).toContain('locus enter client-acme');
    const bare = planResource(acmeKey, new Set());
    expect(bare.store).toBe('os-keychain');
    expect(bare.binding).toBe('label-only');
    // the value is never an argv element: keychain uses the interactive -w prompt
    expect(bare.steps[0]).toMatch(/-w\s/);
  });

  it('rejects secret-shaped text in any field and redacts it', () => {
    expect(looksLikeSecretValue(FAKE_KEY)).toBe(true);
    expect(looksLikeSecretValue('OPENAI_API_KEY')).toBe(false);
    expect(validateEntry({ ...acmeKey, label: FAKE_KEY }).ok).toBe(false);
    expect(validateEntry({ ...acmeKey, credentialName: 'lower' }).ok).toBe(false);
    expect(validateEntry({ ...acmeKey, scopeName: '' }).ok).toBe(false);
    expect(validateEntry(acmeKey).ok).toBe(true);
    expect(redactSecrets(`key=${FAKE_KEY} ref=phm_abc`)).toBe('key=[redacted] ref=phm_abc');
  });
});

describe('setup assistant', () => {
  it('proposes confirmable steps and a brief with references only', () => {
    const enabled = new Set(['phantom-secrets', 'locus'] as const);
    const plans = [planResource(claude, enabled), planResource({ ...acmeKey, label: `leak ${FAKE_KEY}` }, enabled)];
    const proposals = buildProposals(enabled, plans, new Set(['locus']));
    const install = proposals.find((p) => p.id === 'install:companions')!;
    expect(install.command).toContain('ashlrai/phantom/phantom');
    expect(install.command).not.toContain('locus');
    expect(proposals.at(-1)?.kind).toBe('verify');
    const brief = buildAssistantBrief(enabled, plans, proposals);
    expect(brief).toContain('phm:OPENAI_API_KEY_ACME');
    expect(brief).not.toContain(FAKE_KEY);
  });

  it('works with zero companions', () => {
    const proposals = buildProposals(new Set(), [planResource(claude, new Set())]);
    expect(proposals.map((p) => p.kind)).toEqual(['connect-resource', 'verify']);
  });
});

describe('context import', () => {
  it('discovers known files, previews redacted, imports only with consent', () => {
    const home = mkdtempSync(join(tmpdir(), 'phm-setup-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'phm-setup-cwd-'));
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), `# me\nprefer pnpm\ntoken ${FAKE_KEY}\n`);
    writeFileSync(join(home, '.codex', 'auth.json'), '{"secret":true}');
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules');
    const sources = discoverContextSources(home, cwd);
    expect(sources.map((s) => s.id).sort()).toEqual(['claude-global', 'project-agents']);
    const claudeSrc = sources.find((s) => s.id === 'claude-global')!;
    const preview = previewSource(claudeSrc);
    expect(preview.text).not.toContain(FAKE_KEY);
    expect(preview.redactions).toBe(1);
    expect(() => importSource(claudeSrc, { consent: false, home })).toThrow(/consent/);
    const dest = importSource(claudeSrc, { consent: true, home });
    expect(readFileSync(dest, 'utf8')).toContain('prefer pnpm');
    expect(readFileSync(dest, 'utf8')).not.toContain(FAKE_KEY);
    expect(readdirSync(join(home, '.ashlr', 'context', 'imported'))).toEqual(['claude-global.md']);
    expect(existsSync(join(home, '.ashlr', 'context', 'imported', 'auth.md'))).toBe(false);
  });
});

describe('detection', () => {
  it('ignores relative PATH entries and finds nothing in an empty PATH', () => {
    expect(onPath('definitely-not-a-binary-xyz', '')).toBeNull();
    expect(onPath('node', '.:relative')).toBeNull();
  });
});
