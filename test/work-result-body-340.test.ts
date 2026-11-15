/** workResultBody — the one result-receipt validator shared by the CLI and
 * the desktop POST. Exactly one form; anything the evidence reader would
 * ignore is refused (null). Fake values only. */
import { describe, expect, it } from 'vitest';
import { workResultBody } from '../src/core/comms/work-result-body.js';

describe('workResultBody', () => {
  it('accepts each single valid form', () => {
    expect(workResultBody({ pr: 12, head: 'abc123' })).toEqual({ verified: { pr: 12, head: 'abc123' } });
    expect(workResultBody({ pr: '12', head: 'abc123' })).toEqual({ verified: { pr: 12, head: 'abc123' } });
    expect(workResultBody({ tests: 'vitest 4/4' })).toEqual({ verified: { tests: 'vitest 4/4' } });
    expect(workResultBody({ artifact: 'build/fake.tgz' })).toEqual({ verified: { artifact: 'build/fake.tgz' } });
    expect(workResultBody({ blocked: '  waiting on fake-dep  ' })).toEqual({ blocked: { dependency: 'waiting on fake-dep' } });
    expect(workResultBody({ blocked: 'x'.repeat(200) })).toEqual({ blocked: { dependency: 'x'.repeat(200) } });
  });

  it('refuses zero forms and two forms', () => {
    expect(workResultBody({})).toBeNull();
    expect(workResultBody({ tests: 'ok', artifact: 'a' })).toBeNull();
    expect(workResultBody({ pr: 1, head: 'h', blocked: 'dep' })).toBeNull();
  });

  it('refuses pr without head and head without pr', () => {
    expect(workResultBody({ pr: 3 })).toBeNull();
    expect(workResultBody({ pr: '3', head: '   ' })).toBeNull();
    expect(workResultBody({ head: 'abc' })).toBeNull();
  });

  it('refuses non-positive, fractional and unsafe pr numbers', () => {
    for (const pr of ['0', '-1', '1.5', 0, -1, 1.5, '1e3', ' 1', Number.MAX_SAFE_INTEGER + 1, '9007199254740993']) {
      expect(workResultBody({ pr, head: 'abc' }), String(pr)).toBeNull();
    }
  });

  it('refuses blank text, "unknown" and over-long blocked dependencies', () => {
    expect(workResultBody({ tests: ' ' })).toBeNull();
    expect(workResultBody({ artifact: '' })).toBeNull();
    expect(workResultBody({ blocked: 'unknown' })).toBeNull();
    expect(workResultBody({ blocked: ' UnKnown ' })).toBeNull();
    expect(workResultBody({ blocked: 'x'.repeat(201) })).toBeNull();
  });

  it('refuses non-string values arriving from untrusted JSON', () => {
    const json = (v: unknown) => v as never;
    expect(workResultBody({ tests: json(5) })).toBeNull();
    expect(workResultBody({ artifact: json({}) })).toBeNull();
    expect(workResultBody({ blocked: json(['dep']) })).toBeNull();
    expect(workResultBody({ pr: json(true), head: 'abc' })).toBeNull();
    expect(workResultBody({ pr: 1, head: json(7) })).toBeNull();
    expect(workResultBody({ tests: json(null) })).toBeNull();
  });
});
