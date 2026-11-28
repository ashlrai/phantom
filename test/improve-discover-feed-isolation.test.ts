import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One evidence feed rejecting must not blind the whole discovery pass: the
// throw is isolated into `errors` while the other sources still contribute.
vi.mock('../src/core/improve/friction-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/friction-backlog.js')>();
  return {
    ...actual,
    frictionBacklogItems: vi.fn(async () => { throw new Error('corrupt friction journal'); }),
  };
});

import { discoverBacklog } from '../src/core/improve/discover.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-discover-feed-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const SHA = 'c'.repeat(40);
const http = (body: unknown) => ({ ok: true, stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`, stderr: '' });
/** Fake GitHub: a red default branch so at least one item survives the pass. */
function gh() {
  return async (args: string[]) => {
    const p = args[4]!;
    if (p === 'repos/ashlrai/phantom') return http({ default_branch: 'master' });
    if (p === 'repos/ashlrai/phantom/commits/master/check-runs') return http({ check_runs: [
      { name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'failure', head_sha: SHA, html_url: 'https://github.com/ashlrai/phantom/actions/runs/1/job/2' },
    ] });
    if (p === 'repos/ashlrai/phantom/issues') return http([]);
    return { ok: false, stdout: '', stderr: 'HTTP 404' };
  };
}

describe('discoverBacklog feed isolation', () => {
  it('reports a throwing feed in errors while other sources still contribute items', async () => {
    const res = await discoverBacklog('ashlrai/phantom', { gh: gh() });
    expect(res.errors.some((e) => e.startsWith('frictionBacklogItems:'))).toBe(true);
    expect(res.errors.find((e) => e.startsWith('frictionBacklogItems:'))).toContain('corrupt friction journal');
    // The GitHub polls still produced their item — one bad feed did not
    // reject the pass or invent items for the failed read.
    expect(res.items.map((i) => i.id)).toContain(`ci-red-${SHA.slice(0, 12)}`);
  });
});
