import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkContract, products, readJson } from './cli-json-contract.mjs';

// Inputs are explicit files produced in an isolated, Locus-governed job. This
// checker never discovers binaries, invokes a companion, or reads credentials.
const directory = process.argv.length === 3 ? process.argv[2] : undefined;
if (!directory) {
  console.error('Usage: node test/contracts/check-cli-json.mjs <capture-directory>');
  process.exitCode = 1;
} else {
  for (const product of products) {
    try {
      const value = readJson(join(directory, `${product}.json`));
      const rawExit = readFileSync(join(directory, `${product}.exit-code`), 'utf8');
      if (!/^[012](?:\r?\n)?$/.test(rawExit)) throw new Error('Invalid exit code');
      const errors = checkContract(product, value, Number(rawExit.trim()));
      if (errors.length) throw new Error('Contract drift');
      console.log(`${product}: PASS`);
    } catch {
      // Fixed diagnostics keep even malformed/error output value-blind.
      console.error(`${product}: FAIL (missing, invalid, or incompatible capture; review the pinned contract)`);
      process.exitCode = 1;
    }
  }
}
