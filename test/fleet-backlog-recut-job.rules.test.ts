import { describe, expect, it } from 'vitest';
import { renderBacklogRecutJob } from '../src/core/fleet/backlog-recut-job.js';

const BODY = renderBacklogRecutJob(2523, 'abc123', 'bridge: RQ-PHX-EXAMPLE');

describe('backlog recut job rules (verbatim)', () => {
  it('contains sentence 1: apply-only hunks + stale-base recovery', () => {
    expect(BODY).toContain(
      "Apply only the hunks that belong to this PR's own concern. Before stopping, git diff --stat origin/master must list only the files you planned for this concern (write that list in BRIDGE_NOTES.md first); check every hunk as well as every path. Create a JSON array of the exact planned paths outside the worktree, including any new tests and BRIDGE_NOTES.md, then run node scripts/verify-recut-paths.mjs origin/master <paths.json>; resolve every unplanned path before stopping. Never force-push.",
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

  it('uses a unique merge base and excludes base-only history', () => {
    expect(BODY).toContain('git merge-base --all origin/master abc123');
    expect(BODY).toContain('git diff <merge-base> abc123 --');
    expect(BODY).toContain('Stop if there is not exactly one merge base');
    expect(BODY).toContain('never apply it or copy whole old files');
  });

  it('body is under 4000 bytes with 120-char title', () => {
    const bytes = Buffer.byteLength(BODY, 'utf-8');
    expect(bytes).toBeLessThan(4000);
  });
});
