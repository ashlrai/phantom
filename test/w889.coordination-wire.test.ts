import { describe, it, expect } from 'vitest';
import {
  companionDigestToReference,
  companionDigestFromReference,
  projectCompanionWire,
  decodeCompanionWire,
} from '../src/core/proactive/coordination-wire.js';

const HEX64 = 'a'.repeat(64);
const REF64 = companionDigestToReference(HEX64);

// A different valid sha256 reference; decoded to 'bbbbbbbbcccccccc...' = 8 b's + 8 c's + ...
const DIFFERENT_REF64 = 'sha256:bbbbbbbb.cccccccc.dddddddd.eeeeeeee.ffffffff.00000000.11111111.22222222';
const DIFFERENT_HEX64 = 'bbbbbbbb' + 'cccccccc' + 'dddddddd' + 'eeeeeeee' + 'ffffffff' + '00000000' + '11111111' + '22222222';

// ---------------------------------------------------------------------------
// companionDigestToReference
// ---------------------------------------------------------------------------

describe('companionDigestToReference', () => {
  it('formats a 64-char hex digest as sha256 dot-separated groups of 8', () => {
    expect(companionDigestToReference(HEX64)).toBe(REF64);
  });

  it('passes through non-hex strings unchanged', () => {
    expect(companionDigestToReference('not-a-digest')).toBe('not-a-digest');
    expect(companionDigestToReference('ZZZZ'.repeat(16))).toBe('ZZZZ'.repeat(16));
  });
});

// ---------------------------------------------------------------------------
// companionDigestFromReference
// ---------------------------------------------------------------------------

describe('companionDigestFromReference', () => {
  it('expands a sha256 dot-referenced string to 64-char hex', () => {
    expect(companionDigestFromReference(REF64)).toBe(HEX64);
  });

  it('passes through strings that are not sha256 references', () => {
    expect(companionDigestFromReference(HEX64)).toBe(HEX64);
    expect(companionDigestFromReference('random-string')).toBe('random-string');
  });
});

// ---------------------------------------------------------------------------
// projectCompanionWire (encode)
// ---------------------------------------------------------------------------

describe('projectCompanionWire', () => {
  it('encodes digest fields in a flat object', () => {
    const input = { packetDigest: HEX64, resultDigest: DIFFERENT_HEX64, name: 'test' };
    const result = projectCompanionWire(input) as Record<string, unknown>;
    expect(result).toHaveProperty('name', 'test');
    expect(result.packetDigest).not.toBe(HEX64);
    expect((result.packetDigest as string).startsWith('sha256:')).toBe(true);
    expect(result.resultDigest).not.toBe(DIFFERENT_HEX64);
  });

  it('passes through non-object values unchanged', () => {
    expect(projectCompanionWire(null)).toBe(null);
    expect(projectCompanionWire(42)).toBe(42);
    expect(projectCompanionWire('string')).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// decodeCompanionWire (decode)
// ---------------------------------------------------------------------------

describe('decodeCompanionWire', () => {
  it('decodes sha256 references back to 64-char hex in a flat object', () => {
    const input = { packetDigest: REF64, name: 'test' };
    const result = decodeCompanionWire(input) as Record<string, unknown>;
    expect(result).toHaveProperty('name', 'test');
    expect(result.packetDigest).toBe(HEX64);
  });

  it('handles nested arrays of objects with digest fields', () => {
    const input = {
      items: [
        { packetDigest: DIFFERENT_REF64, checkedResultDigest: DIFFERENT_HEX64 },
        { resultDigest: 'd'.repeat(64) },
      ],
    };
    const result = decodeCompanionWire(input) as Record<string, unknown>;
    const items = (result as Record<string, unknown>).items as unknown[];
    expect(Array.isArray(items)).toBe(true);
    expect((items[0] as Record<string, unknown>).packetDigest).toBe(DIFFERENT_HEX64);
    expect((items[0] as Record<string, unknown>).checkedResultDigest).toBe(DIFFERENT_HEX64);
    expect((items[1] as Record<string, unknown>).resultDigest).toBe('d'.repeat(64));
  });
});
