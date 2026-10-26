import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProposalPr, renderPublicProposal, type Exec, type Proposal } from '../src/core/improve/loop.js';

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), tmpdir: vi.fn() }));
let sandbox: string;
let calls: string[][];
let worktree: string;
const proposal = (): Proposal => ({ id: 'a012345678', title: 'Improve routing', rationale: 'Public rationale',
  evidence: [], evalPlan: 'Fixture replay', metric: 'success' });

function executor(hook?: (cmd: string, args: string[], cwd: string) => void, visibility = 'public'): Exec {
  return (cmd, args, cwd) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      worktree = args[4]!;
      fs.mkdirSync(worktree);
    }
    hook?.(cmd, args, cwd);
    if (cmd === 'git' && args[0] === 'symbolic-ref') return 'origin/main\n';
    if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ full_name: 'acme/project', private: visibility !== 'public', visibility });
    if (cmd === 'gh' && args[0] === 'pr') return 'https://github.com/acme/project/pull/1\n';
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args.at(-1)!, { recursive: true });
    return '';
  };
}
beforeEach(() => {
  sandbox = fs.mkdtempSync(join(process.cwd(), '.improve-boundary-'));
  vi.mocked(tmpdir).mockReturnValue(sandbox);
  calls = []; worktree = '';
});
afterEach(() => { vi.resetAllMocks(); fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('improvement proposal boundary', () => {
  it('preserves an unrelated deterministic temporary directory for the same proposal', () => {
    const stale = join(sandbox, `phm-improve-${proposal().id}`);
    fs.mkdirSync(stale); fs.writeFileSync(join(stale, 'precious.txt'), 'unrelated');
    expect(openProposalPr(proposal(), sandbox, executor())).toContain('/pull/1');
    expect(fs.readFileSync(join(stale, 'precious.txt'), 'utf8')).toBe('unrelated');
    expect(worktree).not.toBe(stale);
    expect(calls.some((c) => c.includes('--force'))).toBe(false);
    expect(fs.existsSync(dirname(worktree))).toBe(false);
  });

  it.each(['../../victim', '../x', 'x/y', '', 'BADID', '01234567890'])('rejects noncanonical id %j before any operation', (id) => {
    expect(() => openProposalPr({ ...proposal(), id }, sandbox, executor())).toThrow();
    expect(calls).toEqual([]);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  });

  it.each(['', 'main', 'origin/', 'origin/--upload-pack=unsafe', 'origin/bad..ref', 'origin/bad ref'])('refuses unknown or invalid default-branch metadata %j before writes', (head) => {
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'symbolic-ref') return head;
      if (cmd === 'git' && args[0] === 'check-ref-format') throw new Error('invalid branch ref');
      return '';
    };
    expect(() => openProposalPr(proposal(), sandbox, exec)).toThrow();
    expect(calls.every((c) => c[0] === 'git' && ['symbolic-ref', 'check-ref-format'].includes(c[1]!))).toBe(true);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  });

  it('retains an uncertain worktree-add result instead of cleaning it blindly', () => {
    expect(() => openProposalPr(proposal(), sandbox, executor((cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        fs.writeFileSync(join(worktree, 'partial.txt'), 'partial add');
        throw new Error('uncertain add');
      }
    }))).toThrow('uncertain add');
    expect(fs.readFileSync(join(worktree, 'partial.txt'), 'utf8')).toBe('partial add');
    expect(calls.some((c) => c[1] === 'worktree' && c[2] === 'remove')).toBe(false);
  });

  it('refuses a worktree changed to a link after acquisition without writing or cleaning its target', () => {
    const outside = join(sandbox, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'precious.txt'), 'unrelated');
    expect(() => openProposalPr(proposal(), sandbox, executor((cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        fs.renameSync(worktree, worktree + '-saved'); fs.symlinkSync(outside, worktree);
      }
    }))).toThrow();
    expect(fs.readdirSync(outside)).toEqual(['precious.txt']);
    expect(calls.some((c) => c[1] === 'push' || c[0] === 'gh' || c[2] === 'remove')).toBe(false);
  });

  it('refuses a tracked proposals-ancestor link in the checkout', () => {
    const outside = join(sandbox, 'outside'); fs.mkdirSync(outside);
    expect(() => openProposalPr(proposal(), sandbox, executor((cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') fs.symlinkSync(outside, join(worktree, 'workplans'));
    }))).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(calls.some((c) => c[1] === 'push' || c[0] === 'gh')).toBe(false);
  });

  it('never overwrites an existing proposal artifact', () => {
    let body = '';
    expect(() => openProposalPr(proposal(), sandbox, executor((cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        fs.mkdirSync(join(worktree, 'workplans/proposals'), { recursive: true });
        body = join(worktree, `workplans/proposals/${proposal().id}.md`);
        fs.writeFileSync(body, 'existing artifact');
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') throw new Error('dirty checkout retained');
    }))).toThrow();
    expect(fs.readFileSync(body, 'utf8')).toBe('existing artifact');
    expect(calls.some((c) => c[1] === 'push' || c[0] === 'gh')).toBe(false);
  });

  it('does not publish or force-clean a late replaced worktree', () => {
    const outside = join(sandbox, 'outside'); fs.mkdirSync(outside);
    expect(() => openProposalPr(proposal(), sandbox, executor((cmd, args) => {
      if (cmd === 'git' && args[0] === 'commit') {
        fs.renameSync(worktree, worktree + '-saved'); fs.symlinkSync(outside, worktree);
      }
    }))).toThrow();
    expect(calls.some((c) => c[1] === 'push' || c[0] === 'gh' || c[2] === 'remove')).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each(['private', 'internal', 'unknown', 'error', 'mismatch', 'missing', 'private-missing', 'private-string'])('withholds evidence for %s or unverified repositories', (state) => {
    const p = { ...proposal(), evidence: [{ ref: 'https://github.com/acme/project/issues/1', summary: 'private detail' }] };
    const underlying = executor();
    const exec: Exec = (cmd, args, cwd) => {
      if (cmd === 'gh' && args[0] === 'api') {
        calls.push([cmd, ...args]);
        if (state === 'error') throw new Error('unavailable');
        const status: Record<string, unknown> = { full_name: 'acme/project', private: false, visibility: 'public' };
        if (state === 'mismatch') status.full_name = 'different/project';
        else if (state === 'private-missing') delete status.private;
        else if (state === 'private-string') status.private = 'false';
        else if (state !== 'missing') { status.visibility = state; status.private = state === 'private'; }
        return JSON.stringify(state === 'missing' ? {} : status);
      }
      return underlying(cmd, args, cwd);
    };
    openProposalPr(p, sandbox, exec);
    const creation = calls.find((c) => c[0] === 'gh' && c[1] === 'pr')!;
    const body = creation[creation.indexOf('--body') + 1]!;
    expect(body).not.toContain('acme/project/issues/1');
    expect(body).not.toContain('private detail');
    expect(body).toContain('withheld');
  });

  it('retains exact public evidence only after a fresh repository visibility read', () => {
    const p = { ...proposal(), evidence: [{ ref: 'https://github.com/acme/project/issues/1', summary: 'private detail' }] };
    expect(renderPublicProposal(p)).not.toContain('acme/project/issues/1');
    openProposalPr(p, sandbox, executor());
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'api' && c[2] === 'repos/acme/project')).toBe(true);
    const creation = calls.find((c) => c[0] === 'gh' && c[1] === 'pr')!;
    expect(creation[creation.indexOf('--body') + 1]).toContain('https://github.com/acme/project/issues/1');
    expect(creation.join(' ')).not.toContain('private detail');
  });

  it.each(['commit', 'push'])('holds the next public effect when repository visibility changes after %s', (boundary) => {
    const p = { ...proposal(), evidence: [{ ref: 'https://github.com/acme/project/issues/1', summary: 'detail' }] };
    let privateRepo = false;
    const underlying = executor((cmd, args) => { if (cmd === 'git' && args[0] === boundary) privateRepo = true; });
    const exec: Exec = (cmd, args, cwd) => {
      if (cmd === 'gh' && args[0] === 'api') {
        calls.push([cmd, ...args]);
        return JSON.stringify({ full_name: 'acme/project', private: privateRepo, visibility: privateRepo ? 'private' : 'public' });
      }
      return underlying(cmd, args, cwd);
    };
    expect(() => openProposalPr(p, sandbox, exec)).toThrow(/visibility changed/);
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'pr')).toBe(false);
    if (boundary === 'commit') expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(false);
  });

  it('scrubs the title consistently across branch, commit, PR title and body', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    openProposalPr({ ...proposal(), title: `Fix ${secret}` }, sandbox, executor());
    expect(calls.flat().join(' ')).not.toContain(secret);
    expect(calls.find((c) => c[1] === 'commit')!.join(' ')).toContain('[REDACTED]');
  });

  it('rejects unqualified auto-merge before any filesystem or subprocess operation', () => {
    expect(() => openProposalPr(proposal(), sandbox, executor(), { autoMerge: true })).toThrow(/protected/i);
    expect(calls).toEqual([]);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  });
});
