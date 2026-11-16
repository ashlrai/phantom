/**
 * Preflight fixer and release-flow metrics. The node:test files hold the
 * planning math. This suite checks the workflow shape the hosted runners use.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinned = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
]);

function workflow(name: string) {
  const text = readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8');
  return { text, doc: parse(text) as {
    on?: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, { permissions: Record<string, string>; steps: Array<Record<string, unknown>> }>;
  } };
}

describe('preflight and metrics workflows', () => {
  it('rejects workflow_run on the preflight fixer', () => {
    const { text, doc } = workflow('preflight-fixer.yml');
    expect(text).not.toMatch(/workflow_run/);
    expect(Object.keys(doc.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it.each(['preflight-fixer.yml', 'release-flow-metrics.yml'])('%s is empty at the top and pinned per job', (name) => {
    const { text, doc } = workflow(name);
    expect(doc.permissions).toEqual({});
    expect(text).not.toMatch(/secrets\.|pull_request_target|persist-credentials:\s*true/);
    for (const job of Object.values(doc.jobs)) {
      expect(job.permissions).toBeTruthy();
      for (const [scope, level] of Object.entries(job.permissions)) {
        expect(['actions', 'checks', 'contents', 'issues']).toContain(scope);
        expect(['read', 'write']).toContain(level);
      }
      if (name === 'release-flow-metrics.yml') expect(job.permissions).not.toHaveProperty('issues');
      for (const step of job.steps) {
        if (typeof step.uses === 'string') {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          expect(pinned.has(step.uses.split(' ').at(0) ?? '')).toBe(true);
        }
        if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
          expect(step.with).toMatchObject({ 'persist-credentials': false });
        }
      }
    }
  });
});
