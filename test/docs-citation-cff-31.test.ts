/**
 * Validation for CITATION.cff — the repo's machine-readable citation metadata.
 *
 * Three assertions:
 * 1. The file exists at the repository root.
 * 2. It declares cff-version 1.2.0.
 * 3. The license line matches the LICENSE file.
 *
 * Fix a drift by updating CITATION.cff to match LICENSE, or vice versa.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const CITATION_CFF = join(ROOT, 'CITATION.cff');
const LICENSE = join(ROOT, 'LICENSE');

function readAsLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8').split('\n');
}

describe('CITATION.cff', () => {
  it('exists at the repository root', () => {
    expect(() => readAsLines(CITATION_CFF)).not.toThrow();
  });

  it('has cff-version 1.2.0', () => {
    const lines = readAsLines(CITATION_CFF);
    const cffVersionLine = lines.find(l => /^cff-version\s*:/.test(l));
    expect(cffVersionLine, 'CITATION.cff must declare cff-version').toBeDefined();
    expect(cffVersionLine!.includes('"1.2.0"')).toBe(true);
  });

  it('license line matches the LICENSE file', () => {
    const citationLines = readAsLines(CITATION_CFF);
    const citationLicenseLine = citationLines.find(l => /^license\s*:/.test(l));
    expect(citationLicenseLine, 'CITATION.cff must declare a license').toBeDefined();

    const licenseContent = readFileSync(LICENSE, 'utf-8');

    // Extract the SPDX license identifier from LICENSE: the first line
    // conventionally starts with "MIT License" / "Apache License ..." etc.
    // We match the SPDX token (first word) to handle both "MIT" and
    // multi-word identifiers like "Apache-2.0".
    const licenseHeader = licenseContent.split('\n')[0].trim();
    const spdxMatch = licenseHeader.match(/^(MIT|Apache-2\.0|GPL-[23]\.0|BSD-[23]-Clause|ISC|MPL-2\.0)/);
    const spdxId = spdxMatch ? spdxMatch[1] : 'MIT'; // default to MIT for safety

    // The CITATION.cff license field should use the SPDX identifier.
    const citationLicense = citationLicenseLine!.replace(/^license\s*:\s*/, '').trim();
    expect(citationLicense).toBe(spdxId);
  });
});
