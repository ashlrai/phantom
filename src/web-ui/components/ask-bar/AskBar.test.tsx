/**
 * AskBar component test — the flag gate, the ask.v1 post onto the loopback
 * bus, and the ask.status.v1 chips. The bus is the window's same-origin
 * event plane, so the tests listen and emit on `window` exactly like the
 * intake bridge and the status stream will.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS_STORAGE_KEY, resetFeatureFlagsForTests, setFeatureFlag } from '../../data/feature-flags.js';
import { AskBar } from './AskBar.js';
import { ASK_POST_EVENT, ASK_STATUS_EVENT, postAskStatusToBus, type AskStatusV1, type AskV1 } from './ask-bus.js';

const ASK_ID = /^RQ-ASK-[0-9]{8}-[A-Z0-9]{4,12}$/;
/** The frozen ask.v1 timestamp shape: seconds precision, Z or offset — no `.sssZ`. */
const ASK_TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:?[0-9]{2}|Z)$/;
const nowTs = () => `${new Date().toISOString().slice(0, 19)}Z`;

/** Collect every ask.v1 envelope posted to the bus during a test. */
function collectPosts(): { posts: AskV1[]; stop: () => void } {
  const posts: AskV1[] = [];
  const listener = (event: Event) => posts.push((event as CustomEvent<AskV1>).detail);
  window.addEventListener(ASK_POST_EVENT, listener);
  return { posts, stop: () => window.removeEventListener(ASK_POST_EVENT, listener) };
}

function statusFor(askId: string, state: AskStatusV1['state'], extra: Partial<AskStatusV1> = {}): AskStatusV1 {
  return {
    schema: 'ask.status.v1', ask_id: askId, job_id: null, state, pool: null,
    ts: nowTs(), pr: null, pr_url: null, merged_at: null,
    reverted_at: null, checks: null, reason: null, tokens_total: null, wall_s: null,
    ...extra,
  };
}

async function submitAsk(text = 'Add a --json flag to phm queue stats') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Ask'), text);
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  return user;
}

beforeEach(() => {
  localStorage.clear();
  resetFeatureFlagsForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetFeatureFlagsForTests();
});

describe('the one-ask bar', () => {
  it('renders nothing while the oneAsk flag is off', () => {
    const { container } = render(<AskBar />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('region', { name: 'Ask bar' })).not.toBeInTheDocument();
    expect(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it('posts a queued ask.v1 envelope to the loopback bus on submit', async () => {
    setFeatureFlag('oneAsk', true);
    const { posts, stop } = collectPosts();
    render(<AskBar />);
    await submitAsk();
    stop();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      schema: 'ask.v1',
      text: 'Add a --json flag to phm queue stats',
      repo: 'ashlrai/phantom',
      tier: 'work',
      state: 'queued',
      paths: [],
      acceptance: [],
      pools_allowed: [],
      job_ids: [],
      n: 1,
      pr: null,
      pr_url: null,
      refusal_reason: null,
    });
    expect(posts[0]!.id).toMatch(ASK_ID);
    expect(posts[0]!.created_ts).toMatch(ASK_TS);
    expect(screen.getByLabelText('Ask')).toHaveValue('');
  });

  it('renders the target chip and a status chip per posted ask', async () => {
    setFeatureFlag('oneAsk', true);
    const { posts, stop } = collectPosts();
    render(<AskBar />);
    await submitAsk();
    stop();
    expect(screen.getByText('ashlrai/phantom · work')).toBeInTheDocument();
    expect(screen.getByText(`${posts[0]!.id.split('-').pop()} · queued`)).toBeInTheDocument();
  });

  it('tracks ask.status.v1 events on the bus and ignores other asks', async () => {
    setFeatureFlag('oneAsk', true);
    const { posts, stop } = collectPosts();
    render(<AskBar />);
    await submitAsk();
    stop();
    const askId = posts[0]!.id;
    const suffix = askId.split('-').pop()!;

    act(() => { postAskStatusToBus(statusFor(askId, 'running', { job_id: 'RQ-ASK-1-AAA' })); });
    expect(await screen.findByText(`${suffix} · running`)).toBeInTheDocument();

    // A status for an ask this bar never posted is not its business.
    act(() => { postAskStatusToBus(statusFor('RQ-ASK-20261028-ZZZZ', 'failed')); });
    expect(screen.queryByText(/ZZZZ/)).not.toBeInTheDocument();

    act(() => { postAskStatusToBus(statusFor(askId, 'merged', { pr: 1234, pr_url: 'https://github.com/ashlrai/phantom/pull/1234', merged_at: nowTs(), checks: 'success' })); });
    expect(await screen.findByText(`${suffix} · merged · #1234`)).toBeInTheDocument();
  });

  it('keeps the queued chip when the status event is malformed', async () => {
    setFeatureFlag('oneAsk', true);
    const { posts, stop } = collectPosts();
    render(<AskBar />);
    await submitAsk();
    stop();
    const suffix = posts[0]!.id.split('-').pop()!;
    act(() => {
      window.dispatchEvent(new CustomEvent(ASK_STATUS_EVENT, { detail: { schema: 'ask.status.v1', ask_id: posts[0]!.id, state: 'bogus' } }));
    });
    expect(screen.getByText(`${suffix} · queued`)).toBeInTheDocument();
    expect(screen.queryByText(/bogus/)).not.toBeInTheDocument();
  });

  it('refuses empty and credential-shaped asks before they reach the bus', async () => {
    setFeatureFlag('oneAsk', true);
    const { posts, stop } = collectPosts();
    render(<AskBar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Describe the change first.');
    expect(posts).toHaveLength(0);

    await user.type(screen.getByLabelText('Ask'), 'use key ghp_0123456789abcdefghijklmnop');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/credential/);
    stop();
    expect(posts).toHaveLength(0);
    expect(screen.queryByText(/· queued/)).not.toBeInTheDocument();
  });
});
