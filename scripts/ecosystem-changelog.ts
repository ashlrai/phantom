/** Offline adapter. Usage: npx tsx scripts/ecosystem-changelog.ts input.md output-dir */
import process from 'node:process';
import { writeEcosystemChangelogArtifacts } from '../src/core/ecosystem/changelog.js';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) throw new Error('Usage: ecosystem-changelog.ts input.md|input.json output-dir');
await writeEcosystemChangelogArtifacts(input, output);
