import { describe, expect, it } from 'vitest';
// @ts-expect-error -- standalone ESM operator script
import { PARITY_CASES, compareDiagnostics, parityGaps, parseDiagnosticCodes, unprovenCases } from '../scripts/tsgo-parity.mjs';

const REQUIRED_CODES = ['TS4058', 'TS2352', 'TS2322', 'TS2345', 'TS7006', 'TS18048', 'TS2307'];

const tscOutput = [
  'case-ts4058.ts(2,17): error TS4058: Return type of exported function has or is using name \'Hidden\' from external module "/tmp/x/case-ts4058-hidden" but cannot be named.',
  'case-ts2322.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'case-ts2352.ts(2,10): error TS2352: Conversion of type \'number\' to type \'string\' may be a mistake because neither type sufficiently overlaps with the other.',
].join('\n');
const tsgoOutput = [
  'case-ts4058.ts(2,17): error TS4058: Return type of exported function has or is using name \'Hidden\' from external module "/tmp/x/case-ts4058-hidden" but cannot be named.',
  'case-ts2352.ts(2,10): error TS2352: Conversion of type \'number\' to type \'string\' may be a mistake because neither type sufficiently overlaps with the other.',
].join('\n');

describe('tsgo parity comparison', () => {
  it('covers exactly the error classes #2624 must prove', () => {
    expect(PARITY_CASES.map((testCase: { code: string }) => testCase.code)).toEqual(REQUIRED_CODES);
    for (const testCase of PARITY_CASES) {
      const files = Object.entries(testCase.files);
      expect(files.length).toBeGreaterThan(0);
      for (const [name, content] of files) {
        expect(name).toMatch(/\.ts$/);
        expect(content).toContain('\n');
      }
    }
  });

  it('extracts unique diagnostic codes from compiler output', () => {
    expect([...parseDiagnosticCodes(`${tscOutput}\n${tscOutput}`)].sort()).toEqual(['TS2322', 'TS2352', 'TS4058']);
    expect(parseDiagnosticCodes('warning: something else\nnotes: no errors here').size).toBe(0);
  });

  it('marks each class reported per compiler from injected output', () => {
    const results = compareDiagnostics(PARITY_CASES, tscOutput, tsgoOutput);
    expect(results).toEqual(REQUIRED_CODES.map((code) => ({
      code,
      tscReported: ['TS4058', 'TS2352', 'TS2322'].includes(code),
      tsgoReported: ['TS4058', 'TS2352'].includes(code),
    })));
  });

  it('flags only classes tsc reported that tsgo missed', () => {
    const results = compareDiagnostics(PARITY_CASES, tscOutput, tsgoOutput);
    expect(parityGaps(results)).toEqual(['TS2322']);
  });

  it('treats classes only tsgo reported as no gap', () => {
    const results = compareDiagnostics(PARITY_CASES, tsgoOutput, tscOutput);
    expect(parityGaps(results)).toEqual([]);
  });

  it('flags classes tsc never reported as unproven', () => {
    const results = compareDiagnostics(PARITY_CASES, tscOutput, tsgoOutput);
    expect(unprovenCases(results)).toEqual(['TS2345', 'TS7006', 'TS18048', 'TS2307']);
  });
});
