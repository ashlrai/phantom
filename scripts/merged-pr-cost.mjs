#!/usr/bin/env node
// Tokens and dollars per merged PR by pool, over the local fleet-hop spool.
// Usage:
//   node scripts/merged-pr-cost.mjs [--window 1d|7d|30d] [--spool <path>]
// Prints the MergedPrCostRollup JSON on stdout. Always exits 0 so the caller's
// exit code is unchanged. Requires `npm run build`.
try {
  const { mergedPrCostRollupFromSpool } = await import('../dist/core/observability/rollup.js');
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--window' && argv[i + 1]) opts.window = argv[++i];
    else if (argv[i] === '--spool' && argv[i + 1]) opts.spoolPath = argv[++i];
  }
  process.stdout.write(JSON.stringify(mergedPrCostRollupFromSpool(opts)) + '\n');
} catch {
  // telemetry never fails the caller
}
process.exit(0);
