/** A first-result guide shared by the tour and its Settings disclosure. */
import { useState } from 'react';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { agentsBoardQuery } from '../agents/agents-queries.js';
import { Button } from '../../../components/primitives/Button.js';
import { requestAgentsFocus } from '../agents/agents-focus.js';
import { setVerseSection } from '../verse-ui-store.js';
import styles from './onboarding.module.css';

export function FirstResultGuide() {
  const [open, setOpen] = useState(false);
  const results = useQuery(agentsBoardQuery, { enabled: open });
  const retry = useRefresh(agentsBoardQuery);
  return (
    <details className={styles.guide} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Get one verified result</summary>
      <div role="status">
        {results.status === 'error' ? <>
          <p>Agent results are unavailable. Phantom may be offline or unreachable. We cannot tell whether you have a result to review.
            Check your connection to Phantom, then retry.</p>
          <Button variant="ghost" size="sm" onClick={retry}>Retry results</Button>
        </> : results.status === 'loading' || results.status === 'refreshing' || results.status === 'idle'
          ? <p>Checking agent results…</p>
          : results.data?.cards.length === 0
            ? <p>No agent results yet. Choose a first task below to start a small change, then review its diff and test output.
              This guide does not run a task or verify a result for you.</p>
            : <p>Open Agents to review your work. An agent appearing here does not mean its result has been verified or accepted.</p>}
      </div>
      <dl>
        <dt>1. Choose a repository</dt>
        <dd>Open a repository you can safely work on in Chat. Check the selected folder before asking for changes.</dd>
        <dt>2. Check your resource</dt>
        <dd>Use Apps &amp; Accounts and Resources to check the account or local model, its readiness and reported limits.</dd>
        <dt>3. Ask for one small change</dt>
        <dd>In New agent, select that repository and resource. Try: “Fix one reproducible bug, add a regression test,
          and run the relevant repository tests. Show the diff and the test command with its output. Ask before expanding scope.”</dd>
        <dt>4. Review and accept</dt>
        <dd>Open the agent’s chat to inspect the actual diff and test output. Its Checks tab shows reported CI when available.
          Missing or unknown checks do not verify the work. Accept the result only when it meets your stated criteria.</dd>
      </dl>
      <Button variant="ghost" size="sm" onClick={() => setVerseSection('apps')}>Open Apps &amp; Accounts</Button>{' '}
      <Button variant="subtle" size="sm" onClick={() => requestAgentsFocus('new')}>Choose a first task</Button>
    </details>
  );
}
