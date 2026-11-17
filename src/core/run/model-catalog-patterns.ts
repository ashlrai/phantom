export interface CatalogPattern {
  pattern: string;
  sources: string[];
  tier?: 'lite' | 'normal';
}

export const MODEL_CATALOG_PATTERNS: readonly CatalogPattern[] = [
  { pattern: '^claude-(haiku|sonnet)-', sources: ['claude', 'devin'], tier: 'lite' },
  { pattern: '^claude-opus-', sources: ['claude', 'devin'], tier: 'normal' },
  { pattern: '^claude-fable-', sources: ['claude', 'devin'] },
  { pattern: '^gpt-[0-9.]+-terra$', sources: ['codex', 'devin'], tier: 'lite' },
  { pattern: '^gpt-', sources: ['codex', 'devin'] },
  { pattern: '^grok-.*-fast$', sources: ['grok', 'cursor'], tier: 'lite' },
  { pattern: '^grok-', sources: ['grok', 'cursor'] },
  { pattern: '^[^\\s:]+:[^\\s:]+$', sources: ['ollama'], tier: 'lite' },
  { pattern: '^meta/', sources: ['cursor'] },
];
