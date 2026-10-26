/**
 * Ported from the retired m479 and m515 release.yml suites (2026-10-26) to the
 * single live release path, publish-canonical-npm.yml:
 *  - m479: every action the publisher runs is pinned to an immutable commit
 *    with a version comment (workflow and reusable-action refs alike).
 *  - m515 pack report: release.yml compared per-member path/mode/size from
 *    `npm pack --json`. The live path binds the WHOLE original archive by
 *    sha256 (attested CI artifact -> admission -> handoff), so a member swap,
 *    a traversal path or a mode change is any byte change to the archive and
 *    must be refused at admission and at handoff.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { acceptPackageIdentity, publisherInput, verifyHandoff } from '../scripts/canonical-npm-publisher.mjs';

const workflowText = readFileSync(new URL('../.github/workflows/publish-canonical-npm.yml', import.meta.url), 'utf8');

function actionRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) actionRefs(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'uses' && typeof entry === 'string') out.push(entry);
      else actionRefs(entry, out);
    }
  }
  return out;
}

describe('publish-canonical-npm.yml action pinning (from m479)', () => {
  it('pins every non-local action to a 40-hex commit with a version comment', () => {
    const refs = actionRefs(parse(workflowText));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      if (ref.startsWith('./')) continue;
      expect(ref, `mutable action ref: ${ref}`).toMatch(/^[a-z0-9_.-]+\/[a-z0-9_./-]+@[0-9a-f]{40}$/iu);
      const line = workflowText.split('\n').find((text) => text.includes(`uses: ${ref}`));
      expect(line, `version comment for ${ref}`).toMatch(/@[0-9a-f]{40} # v\d+(?:\.\d+){0,2}\s*$/u);
    }
  });
});

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const env = {GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: '1'.repeat(40), CANDIDATE_SHA: '2'.repeat(40),
  VERSION: '3.27.0', CI_RUN_ID: '4', CI_RUN_ATTEMPT: '1', ATTESTOR_RUN_ID: '5', ATTESTOR_RUN_ATTEMPT: '1', ATTESTED_ARTIFACT_ID: '6', AUDIT_RUN_ID: '7', AUDIT_RUN_ATTEMPT: '1'};
const input = publisherInput(env);
const pkg = {name: '@ashlr/phantom', version: '3.27.0', repository: {url: 'git+https://github.com/ashlrai/phantom.git'}};
// A stand-in archive listing members as path\tmode\tsize, like the old pack report.
const member = (rows: Array<[string, number, number]>) => Buffer.from(rows.map((row) => row.join('\t')).join('\n'));
const original = member([['package/package.json', 420, 100], ['package/dist/build-identity.json', 420, 80], ['package/dist/cli.js', 493, 200]]);
const receipt = {source: {revision: input.revision}, packageSha256: hash(original), attestor: {revision: input.attestorSha, runId: 5, runAttempt: 1}};
const tampered = {
  'member swap': member([['package/package.json', 420, 200], ['package/dist/build-identity.json', 420, 80], ['package/dist/cli.js', 493, 100]]),
  'path traversal': member([['package/package.json', 420, 100], ['package/../outside', 420, 80], ['package/dist/cli.js', 493, 200]]),
  'mode drift': member([['package/package.json', 420, 100], ['package/dist/build-identity.json', 420, 80], ['package/dist/cli.js', 511, 200]]),
};

describe('whole-archive binding refuses pack-report drift (from m515)', () => {
  it('accepts only the attested original bytes', () => {
    expect(acceptPackageIdentity(input, pkg, receipt, original).sha256).toBe(hash(original));
  });
  it.each(Object.entries(tampered))('refuses %s at admission', (_label, bytes) => {
    expect(() => acceptPackageIdentity(input, pkg, receipt, bytes)).toThrow();
  });
  it.each(Object.entries(tampered))('refuses %s at handoff', (_label, bytes) => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-pin-port-'));
    try {
      const accepted = acceptPackageIdentity(input, pkg, receipt, original);
      const admission = Buffer.from(JSON.stringify(accepted));
      writeFileSync(join(dir, 'admission.json'), admission);
      writeFileSync(join(dir, accepted.filename), bytes);
      expect(() => verifyHandoff(dir, hash(admission), hash(original))).toThrow();
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});
