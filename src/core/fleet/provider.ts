/**
 * The one place that answers "which company is behind this model or lane?".
 * The fleet map JSON, the CLI and every badge in the app read `providerFor`.
 * Marks come from the brand registry; a provider with no mark there gets its
 * letter in its colour. A name nobody recognises is `unknown` ("?"), never a guess.
 */
import { BRANDS, resolveBrand, type BrandId } from '../brand/registry.js';

export const PROVIDER_NAMES = ['Anthropic', 'OpenAI', 'Cognition', 'xAI', 'Google', 'Z.ai', 'Cursor', 'Local', 'unknown'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface Provider {
  name: ProviderName;
  /** Badge letter(s); "?" for unknown. */
  letter: string;
  /** Badge colour, #RRGGBB. */
  color: string;
  /** Mark in the brand registry, or null when the badge is the letter alone. */
  brand: BrandId | null;
}

const NEUTRAL = '#8A8F98';
const branded = (name: ProviderName, letter: string, brand: BrandId): Provider => ({ name, letter, color: BRANDS[brand].hex, brand });
export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = {
  Anthropic: branded('Anthropic', 'A', 'claude'),
  OpenAI: branded('OpenAI', 'O', 'codex'),
  Cognition: branded('Cognition', 'C', 'devin'),
  xAI: branded('xAI', 'X', 'grok'),
  Google: branded('Google', 'G', 'gemini'),
  'Z.ai': { name: 'Z.ai', letter: 'Z', color: '#5B6CFF', brand: null },
  Cursor: branded('Cursor', 'Cu', 'cursor'),
  Local: branded('Local', 'L', 'local'),
  unknown: { name: 'unknown', letter: '?', color: NEUTRAL, brand: null },
};

const BY_BRAND: Readonly<Partial<Record<BrandId, ProviderName>>> = {
  claude: 'Anthropic', codex: 'OpenAI', devin: 'Cognition', grok: 'xAI', gemini: 'Google', cursor: 'Cursor', local: 'Local',
};
// A whole word, so "codex-local" is local but "localization-model" is not.
const LOCAL = /(^|[^a-z0-9])(local|omlx|mlx|ollama|lmstudio|lm-studio|llama\.cpp)([^a-z0-9]|$)/;
const ZAI = /(^|[^a-z0-9])(zai|z\.ai|glm|zhipu)([^a-z0-9]|$)/;
const OPENAI_O_SERIES = /^(openai\/)?o\d(-|$)/;

function nameOf(value: string | null | undefined): ProviderName | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;
  if (LOCAL.test(text)) return 'Local';
  if (ZAI.test(text)) return 'Z.ai';
  if (OPENAI_O_SERIES.test(text)) return 'OpenAI';
  const brand = resolveBrand(text);
  return (brand && BY_BRAND[brand]) ?? null;
}

/**
 * Model id or lane -> provider. Pass the most specific name first (model, then
 * lane); the first one recognised wins. A local lane or model always reads
 * Local, because the resource doing the work is this machine.
 */
export function providerFor(...names: Array<string | null | undefined>): Provider {
  const found = names.map(nameOf).filter((name): name is ProviderName => name !== null);
  return PROVIDERS[found.includes('Local') ? 'Local' : found[0] ?? 'unknown'];
}
