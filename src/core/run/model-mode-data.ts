/** Capability/cost classes, independent of provider, transport and queue scope. */
export const MODE_TIERS = ['lite', 'normal', 'ultra', 'fusion'] as const;
export type ModeTier = typeof MODE_TIERS[number];
export type ModelModeTier = Exclude<ModeTier, 'fusion'>;
export const MODE_RANK: Readonly<Record<ModelModeTier, number>> = { lite: 0, normal: 1, ultra: 2 };

/** Exact model tags and historical aliases. Unknown models require explicit snapshot classification. */
export const MODEL_MODE_TIERS: Readonly<Record<string, ModelModeTier>> = {
  'claude-opus-5-5': 'normal', 'claude-opus-5': 'normal', opus: 'normal', 'claude-opus-4-8': 'normal',
  'gpt-6.1-sol': 'normal', 'gpt-6-sol': 'normal', 'gpt-5.5': 'normal',
  'claude-fable-5-2': 'ultra', 'claude-fable-5-1': 'ultra', 'claude-fable-5': 'ultra', 'fable-5': 'ultra',
  'gpt-6-astra': 'ultra',
  'gpt-6.1-terra': 'lite', 'claude-haiku-5-5': 'lite', 'claude-sonnet-5-5': 'lite',
  sonnet: 'lite', 'claude-sonnet-4-6': 'lite', 'sonnet-5': 'lite', 'claude-sonnet-5': 'lite',
  haiku: 'lite', 'claude-haiku-4-5': 'lite',
  'qwen2.5:72b': 'lite', 'qwen2.5-coder:32b': 'lite', 'deepseek-r1:32b': 'lite',
  'qwen3.8:27b-ctx64k': 'lite', small: 'lite',
  'meta/llama-3.1-70b-instruct': 'lite', 'meta/llama-3.1-8b-instruct': 'lite',
  'qwen3-coder-next': 'lite', 'qwen3-coder-30b-a3b': 'lite', 'deepseek-r1-distill-70b': 'lite',
  'grok-4.7': 'normal', 'grok-4.7-build-fast': 'lite',
};
