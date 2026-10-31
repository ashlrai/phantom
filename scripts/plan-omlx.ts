/** Print reviewable settings only. Installation belongs to Masbot under memguard. */
import { readFileSync } from 'node:fs';
import { planOmlxConfig } from '../src/core/local-runtime/omlx/config.js';

try {
  if (process.argv.length !== 3) throw new Error('Usage: npx tsx scripts/plan-omlx.ts request.json');
  const plan = planOmlxConfig(JSON.parse(readFileSync(process.argv[2]!, 'utf8')));
  console.log(JSON.stringify(plan, null, 2));
} catch {
  console.error('oMLX planning refused: check version, canary provenance, fresh memguard snapshot and model budgets');
  process.exitCode = 1;
}
