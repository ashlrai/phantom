/**
 * The Devin-org playbook attached by id (RQ-DEVINPLAYBOOKQ7): the checked-in
 * source in devin/playbooks/, config `devin.playbookId`, the
 * SessionCreateRequest.playbook_id wire field, and the dispatch prompt that
 * references the playbook instead of repeating its conventions.
 *
 * Everything external is faked: the Devin API (test/helpers/fake-devin.ts),
 * the Keychain (test/helpers/fake-keychain.ts) and `gh`. Files live in the
 * worker's isolated ASHLR_HOME (test/setup/home.ts).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { DevinClient } from '../src/core/devin/client.js';
import { buildDevinPrompt } from '../src/core/devin/delivery-contract.js';
import { launchDevinTask, resetDevinStatusCacheForTest, type DevinServiceDeps } from '../src/core/devin/service.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { devinHome, isDevinTask, readDevinTask, writeDevinConnection } from '../src/core/devin/store.js';
import { DEVIN_PLAYBOOK_ID_PATTERN, type DevinTaskV1 } from '../src/core/devin/types.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';

const ROOT = join(__dirname, '..');
const REPO = 'ashlrai/devin-canary';
const PLAYBOOK_ID = 'playbook-abc123def456';
const noSleep = async (): Promise<void> => undefined;

let api: FakeDevin;
let keychain: FakeKeychain;
let ghCalls: string[][];

function deps(extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  return {
    keyStore: { run: keychain.run, platform: 'darwin' },
    fetch: api.fetch,
    sleep: noSleep,
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === 'repo' && args[1] === 'view') return { ok: true, stdout: 'main\n', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    },
    config: () => ({ enabled: true, playbookId: PLAYBOOK_ID }),
    policy: () => null,
    ...extra,
  };
}

async function connect(): Promise<void> {
  await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
  writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
}

function task(): Pick<DevinTaskV1, 'id' | 'prompt' | 'repo' | 'branch' | 'baseBranch' | 'title'> {
  return { id: 'dv_20260927T0400_0000aa', prompt: 'Add a helper', repo: REPO, branch: 'ashlr-devin/dv_20260927T0400_0000aa', baseBranch: 'main', title: 'Add a helper' };
}

function lastCreateBody(): Record<string, unknown> {
  return api.requests.filter((r) => r.method === 'POST').at(-1)!.body as Record<string, unknown>;
}

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  api = fakeDevin({ self: { principal_type: 'service_user', service_user_id: 's', service_user_name: 'Ashlr Verse', org_id: null } });
  keychain = fakeKeychain();
  ghCalls = [];
  resetDevinStatusCacheForTest();
});

// ---------------------------------------------------------------------------

describe('the checked-in playbook source', () => {
  const path = join(ROOT, 'devin', 'playbooks', 'ashlr-pr-conventions.md');
  const body = readFileSync(path, 'utf8');

  it('encodes every dispatch convention the task lists', () => {
    expect(body).toContain('publish.sh');
    expect(body).toContain('fork');
    expect(body).toMatch(/em dash/i);
    expect(body).toMatch(/secrets/i);
    expect(body).toMatch(/acceptance tests/i);
    expect(body).toMatch(/small/i);
    expect(body).toContain('CHANGELOG.md');
    expect(body).toContain('.github/**');
  });

  it('writes no em dash characters itself', () => {
    expect(body).not.toContain('—');
    expect(body).not.toContain('–');
  });
});

describe('the playbook id', () => {
  it('accepts only the documented playbook- shape', () => {
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('playbook-abc123def456')).toBe(true);
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('playbook-x')).toBe(true);
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('org-fake123')).toBe(false);
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('playbook-')).toBe(false);
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('')).toBe(false);
    expect(DEVIN_PLAYBOOK_ID_PATTERN.test('Playbook-abc')).toBe(false);
  });

  it('is declared on the config schema so `devin.playbookId` validates', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'config.schema.json'), 'utf8')) as {
      properties: { devin: { properties: Record<string, { pattern?: string }> } };
    };
    expect(schema.properties.devin.properties['playbookId']?.pattern).toBe('^playbook-[A-Za-z0-9_-]{1,120}$');
  });
});

describe('SessionCreateRequest.playbook_id', () => {
  it('is sent when the input carries a valid id and left out otherwise', async () => {
    const client = new DevinClient({ apiKey: FAKE_KEY, baseUrl: 'https://devin.test/v3', fetch: api.fetch, sleep: noSleep });
    const session = await client.createSession(FAKE_ORG, { prompt: 'Add a helper', playbookId: PLAYBOOK_ID });
    expect(session.sessionId).toMatch(/^devin-/);
    expect(lastCreateBody()['playbook_id']).toBe(PLAYBOOK_ID);

    await client.createSession(FAKE_ORG, { prompt: 'Add a helper' });
    expect(lastCreateBody()).not.toHaveProperty('playbook_id');
  });

  it('rejects a malformed id before any request leaves', async () => {
    const client = new DevinClient({ apiKey: FAKE_KEY, baseUrl: 'https://devin.test/v3', fetch: api.fetch, sleep: noSleep });
    await expect(client.createSession(FAKE_ORG, { prompt: 'Add a helper', playbookId: 'not-a-playbook' }))
      .rejects.toMatchObject({ code: 'invalid-request' });
    expect(api.requests).toHaveLength(0);
  });
});

describe('the dispatch prompt template', () => {
  it('keeps the full boilerplate when no playbook is attached', () => {
    const prompt = buildDevinPrompt(task());
    expect(prompt).toContain('Run the repository\'s relevant checks and tests');
    expect(prompt).toContain('Never put secrets');
    expect(prompt).not.toContain('playbook-');
  });

  it('references the playbook by id and drops the conventions it carries', () => {
    const prompt = buildDevinPrompt(task(), '', PLAYBOOK_ID);
    expect(prompt).toContain(`\`${PLAYBOOK_ID}\``);
    expect(prompt).toContain('PR conventions');
    expect(prompt).not.toContain('Run the repository\'s relevant checks');
    expect(prompt).not.toContain('Never put secrets');
    // No new prompt-token protocol: the id travels on the API field only.
    expect(prompt).not.toContain('@playbook');
    // The delivery mechanics survive in full: branch, one PR, report fence.
    expect(prompt).toContain(`Create branch \`ashlr-devin/${task().id}\``);
    expect(prompt).toContain('```ashlr-devin-report');
    expect(prompt).toContain('structured output');
    // The removed items renumber the remaining rules cleanly (1-8).
    expect(prompt).toMatch(/8\. If you are blocked/);
    expect(prompt).not.toMatch(/\n9\. |\n10\. /);
  });
});

describe('launchDevinTask', () => {
  it('attaches the configured playbook id, records it on the task and shortens the prompt', async () => {
    await connect();
    const res = await launchDevinTask({ repo: REPO, prompt: 'Add a sub helper', origin: 'cli' }, deps());
    expect(res.ok).toBe(true);
    const t = res.task!;
    expect(t.playbookId).toBe(PLAYBOOK_ID);
    const body = lastCreateBody();
    expect(body['playbook_id']).toBe(PLAYBOOK_ID);
    const prompt = String(body['prompt']);
    expect(prompt).toContain(`\`${PLAYBOOK_ID}\``);
    expect(prompt).not.toContain('Run the repository\'s relevant checks');
    expect(prompt).not.toContain('Never put secrets');
    // The persisted record validates and round-trips the field.
    expect(readDevinTask(t.id)).toMatchObject({ playbookId: PLAYBOOK_ID });
  });

  it('sends no playbook field and keeps the boilerplate when none is configured', async () => {
    await connect();
    const res = await launchDevinTask({ repo: REPO, prompt: 'Add a sub helper', origin: 'cli' },
      deps({ config: () => ({ enabled: true }) }));
    expect(res.ok).toBe(true);
    expect(res.task!).not.toHaveProperty('playbookId');
    const body = lastCreateBody();
    expect(body).not.toHaveProperty('playbook_id');
    expect(String(body['prompt'])).toContain('Never put secrets');
  });

  it('refuses a malformed configured id before any API call', async () => {
    await connect();
    const res = await launchDevinTask({ repo: REPO, prompt: 'Add a sub helper', origin: 'cli' },
      deps({ config: () => ({ enabled: true, playbookId: 'not-a-playbook' }) }));
    expect(res).toMatchObject({ ok: false, failure: 'invalid-request' });
    expect(api.requests).toHaveLength(0);
  });

  it('never attaches it to a chat session', async () => {
    await connect();
    const res = await launchDevinTask(
      { repo: REPO, prompt: 'Talk through the refactor', origin: 'chat', contract: 'chat', verseSessionId: 'vs-1' },
      deps());
    expect(res.ok).toBe(true);
    expect(res.task!).not.toHaveProperty('playbookId');
    const body = lastCreateBody();
    expect(body).not.toHaveProperty('playbook_id');
    expect(String(body['prompt'])).not.toContain(PLAYBOOK_ID);
  });
});

describe('the stored task record', () => {
  it('accepts a documented playbook id and rejects anything else', () => {
    const now = new Date().toISOString();
    const base: DevinTaskV1 = {
      v: 1, id: 'dv_20260927T0400_0000aa', repo: REPO, baseBranch: 'main',
      branch: 'ashlr-devin/dv_20260927T0400_0000aa', title: 't', prompt: 'p', origin: 'cli',
      requestedBy: 'mason', sessionId: null, sessionUrl: null, state: 'queued', stateReason: null,
      failure: null, createdAt: now, launchedAt: null, updatedAt: now, session: null,
      maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null,
    };
    expect(isDevinTask(base)).toBe(true);
    expect(isDevinTask({ ...base, playbookId: PLAYBOOK_ID })).toBe(true);
    expect(isDevinTask({ ...base, playbookId: 'not-a-playbook' })).toBe(false);
    expect(isDevinTask({ ...base, playbookId: 42 })).toBe(false);
  });
});
