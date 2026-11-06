import process from 'node:process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { diffModelcaps, renderModelcapsReport } from '../src/core/radar/modelcaps.js';

const [before, after, ...extra] = process.argv.slice(2);
if (!before || !after || extra.length) {
  console.error('Usage: npx tsx scripts/radar-modelcaps.ts BEFORE.json AFTER.json');
  process.exitCode = 1;
} else {
  try {
    const diff = diffModelcaps(JSON.parse(readFileSync(before, 'utf8')), JSON.parse(readFileSync(after, 'utf8')));
    console.log(renderModelcapsReport(diff));
  } catch {
    // Do not echo potentially sensitive response bodies or file contents.
    console.error('Unable to compare inventories: supply readable, valid, complete /v1/models JSON files.');
    process.exitCode = 1;
  }
}
