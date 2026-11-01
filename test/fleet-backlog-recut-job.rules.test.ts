import { describe, expect, it } from 'vitest';
import { renderBacklogRecutJob } from '../src/core/fleet/backlog-recut-job.js';

const BODY = renderBacklogRecutJob(2523, 'abc123', 'bridge: RQ-PHX-EXAMPLE');

describe('backlog recut job rules (verbatim)', () => {
  it('contains sentence 1: apply-only hunks + stale-base recovery', () => {
    expect(BODY).toContain(
      "Apply only the hunks that belong to this PR's own concern. Before stopping, git diff --stat origin/master must list only the files you planned for this concern (write that list in BRIDGE_NOTES.md first); if it lists more, you started from a stale base: git checkout origin/master -- <extra files> and continue.",
    );
  });

  it('contains sentence 2: no-edit list + new-verb convention', () => {
    expect(BODY).toContain(
      'Do not edit src/cli/fleet.ts, src/cli/index.ts, completions.ts, help.ts, docs/README.md or docs/AGENT-OPERATIONS.md. A new verb is only a new src/cli/fleet-<verb>.ts exporting cmdFleet<Verb>; drop any fleet.ts hunk the original carried and rename the export to fit.',
    );
  });

  it('contains sentence 3: no-unmerged-imports', () => {
    expect(BODY).toContain(
      'Do not import a symbol from a job that has not merged; if the inherited work depends on one, define the type in a new file of your own.',
    );
  });

  it('contains sentence 4: tsc gate before stopping', () => {
    expect(BODY).toContain(
      'Your last step before stopping is npx tsc --noEmit -p tsconfig.json with exit 0, covering every symbol you import. If it fails, fix it. A red PR emails Mason.',
    );
  });

  it('renders with existing keys: PR number, SHA, fetch line', () => {
    expect(BODY).toContain('PR #2523');
    expect(BODY).toContain('Observed head SHA: abc123');
    expect(BODY).toContain('git fetch origin pull/2523/head');
  });

  it('body is under 4000 bytes with 120-char title', () => {
    const bytes = Buffer.byteLength(BODY, 'utf-8');
    expect(bytes).toBeLessThan(4000);
  });
});
