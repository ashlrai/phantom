import { groupingFallbackRegression } from './grouping-fallback.test-support.js';

// The ordinary roster accepts this synthetic label; grouping's bounded parser
// rejects its descriptor. Keep quota/credit policy valid so failure is independent.
groupingFallbackRegression(`Synthetic account ${'x'.repeat(241)}`, /Provider grouping unavailable/);
