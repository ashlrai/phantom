/**
 * Coverage for src/core/dailyfix/github-actions.ts — the `gh api` polling
 * client behind the daily-fix consumer (RQ-DAILYFIX-CONSUMER). Hermetic: a
 * fake `gh` executable on PATH serves canned responses; no network, no real
 * gh auth, no HOME.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadArtifact,
  listArtifacts,
  listFailedJobs,
  listWorkflowRuns,
} from '../src/core/dailyfix/github-actions.js';

const REPO = 'ashlrai/phantom';
let binDir: string;
let savedPath: string | undefined;

function installFakeGh(script: string): void {
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, script, { mode: 0o755 });
  chmodSync(ghPath, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'dailyfix-gh-'));
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ''}`;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  rmSync(binDir, { recursive: true, force: true });
});

describe('listWorkflowRuns', () => {
  it('parses workflow_runs and returns the ETag', () => {
    installFakeGh(`#!/bin/sh
printf 'HTTP/2.0 200 OK\\nETag: "abc123"\\n' >&2
cat <<'JSON'
{"workflow_runs":[{"id":42,"name":"CI","status":"completed","conclusion":"failure","event":"schedule","created_at":"2026-11-07T00:00:00Z","updated_at":"2026-11-07T01:00:00Z","head_sha":"deadbeef","head_branch":"master","run_number":7}]}
JSON
`);
    const result = listWorkflowRuns(REPO);
    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('"abc123"');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ id: 42, name: 'CI', conclusion: 'failure' });
  });

  it('reports notModified on a 304 status line', () => {
    installFakeGh(`#!/bin/sh
printf 'HTTP/2.0 304 Not Modified\\n' >&2
exit 0
`);
    const result = listWorkflowRuns(REPO, '"old-etag"');
    expect(result.notModified).toBe(true);
    expect(result.runs).toEqual([]);
  });

  it('returns empty runs on malformed JSON or gh failure', () => {
    installFakeGh('#!/bin/sh\necho "not json"\nexit 0\n');
    expect(listWorkflowRuns(REPO).runs).toEqual([]);
    installFakeGh('#!/bin/sh\nexit 1\n');
    expect(listWorkflowRuns(REPO).runs).toEqual([]);
  });
});

describe('listFailedJobs', () => {
  it('keeps only failure conclusions and extracts shard ids', () => {
    installFakeGh(`#!/bin/sh
cat <<'JSON'
{"jobs":[
 {"name":"CI (Node 22, macos)","conclusion":"failure","labels":["self-hosted","shard-2"],"steps":[{"name":"Test","conclusion":"failure","number":4}]},
 {"name":"Merge Gate","conclusion":"success","labels":[]},
 {"name":"Quick typecheck","conclusion":"timed_out","labels":[]}
]}
JSON
`);
    const jobs = listFailedJobs(REPO, 99);
    expect(jobs.map((j) => j.name)).toEqual(['CI (Node 22, macos)', 'Quick typecheck']);
    expect(jobs[0]?.shardId).toBe('2');
    expect(jobs[1]?.shardId).toBeNull();
  });

  it('returns empty when gh fails', () => {
    installFakeGh('#!/bin/sh\nexit 1\n');
    expect(listFailedJobs(REPO, 1)).toEqual([]);
  });
});

describe('listArtifacts / downloadArtifact', () => {
  it('lists artifacts and ignores malformed entries', () => {
    installFakeGh(`#!/bin/sh
cat <<'JSON'
{"artifacts":[{"id":5,"name":"fixup-queue","size_in_bytes":1024,"expires_at":"2026-11-14T00:00:00Z"},{"id":"bad"}]}
JSON
`);
    const artifacts = listArtifacts(REPO, 7);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ id: 5, name: 'fixup-queue' });
  });

  it('downloadArtifact parses JSON stdout and nulls on failure', () => {
    installFakeGh('#!/bin/sh\necho \'{"ok":true}\'\n');
    expect(downloadArtifact(REPO, 5)).toEqual({ ok: true });
    installFakeGh('#!/bin/sh\nexit 1\n');
    expect(downloadArtifact(REPO, 5)).toBeNull();
  });
});
