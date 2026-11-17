/** Capability/cost classes, independent of provider, transport and queue scope. */
export const MODE_TIERS = ['lite', 'normal', 'ultra', 'fusion'] as const;
export type ModeTier = typeof MODE_TIERS[number];
export type ModelModeTier = Exclude<ModeTier, 'fusion'>;
export const MODE_RANK: Readonly<Record<ModelModeTier, number>> = { lite: 0, normal: 1, ultra: 2 };

export { MODEL_MODE_TIERS } from './model-catalog-data.js';
