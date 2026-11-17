import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES, PROVIDERS, providerFor } from '../src/core/fleet/provider.js';
import { ORG_LANES } from '../src/core/fleet/org-map.js';

const name = (...names: Array<string | null | undefined>) => providerFor(...names).name;

describe('providerFor', () => {
  it('maps every fleet lane to the company behind it', () => {
    const lanes: Record<(typeof ORG_LANES)[number], string> = {
      'codex-personal': 'OpenAI', 'codex-cmp': 'OpenAI', claude: 'Anthropic', 'claude-api': 'Anthropic', devin: 'Cognition', 'devin-flash': 'Cognition',
      'codex-local': 'Local', zai: 'Z.ai', gemini: 'Google', grok: 'xAI', cursor: 'Cursor',
    };
    for (const [lane, provider] of Object.entries(lanes)) expect(name(lane), lane).toBe(provider);
    for (const [lane, provider] of [['claude-cli', 'Anthropic'], ['grok-cli', 'xAI'], ['devin-cli', 'Cognition'], ['codex', 'OpenAI'], ['local', 'Local'], ['omlx', 'Local']]) expect(name(lane), lane).toBe(provider);
  });
  it('maps model ids, with or without a vendor prefix', () => {
    const models: Array<[string, string]> = [
      ['claude-fable-5-2', 'Anthropic'], ['anthropic/claude-opus-5-5', 'Anthropic'], ['gpt-5.5-codex', 'OpenAI'], ['o3', 'OpenAI'], ['o4-mini', 'OpenAI'],
      ['grok-4', 'xAI'], ['gemini-3-pro', 'Google'], ['glm-4.6', 'Z.ai'], ['z.ai/glm-5', 'Z.ai'], ['devin-2', 'Cognition'], ['ollama/qwen3-coder', 'Local'],
    ];
    for (const [model, provider] of models) expect(name(model), model).toBe(provider);
  });
  it('reads its own provider names back, in any case', () => {
    for (const provider of PROVIDER_NAMES) { expect(name(provider)).toBe(provider); expect(name(provider.toUpperCase())).toBe(provider); }
  });
  it('shows a neutral "?" for anything it does not recognise, never a guess', () => {
    for (const value of ['', '  ', null, undefined, 'unknown', 'agy', 'mistral-large', 'qwen3-coder', 'fixture-model', 'constructor', 'toString', '__proto__', 'localization-model', 'o', 'oo3']) {
      expect(providerFor(value), String(value)).toEqual({ name: 'unknown', letter: '?', color: '#8A8F98', brand: null });
    }
    expect(providerFor()).toBe(PROVIDERS.unknown);
  });
  it('prefers the model over the lane, falls back to the lane, and keeps local work local', () => {
    expect(name('claude-sonnet-5-5', 'cursor')).toBe('Anthropic');
    expect(name('fixture-model', 'codex-cmp')).toBe('OpenAI');
    expect(name(null, 'zai')).toBe('Z.ai');
    expect(name('gpt-oss-20b', 'codex-local')).toBe('Local');
    expect(name('unknown', 'unknown')).toBe('unknown');
  });
  it('gives every provider a distinct letter badge and a colour', () => {
    expect(Object.keys(PROVIDERS)).toEqual([...PROVIDER_NAMES]);
    expect(new Set(PROVIDER_NAMES.map(provider => PROVIDERS[provider].letter)).size).toBe(PROVIDER_NAMES.length);
    for (const provider of PROVIDER_NAMES) {
      expect(PROVIDERS[provider].name).toBe(provider);
      expect(PROVIDERS[provider].color).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(PROVIDERS['Z.ai'].brand).toBeNull();
  });
});
