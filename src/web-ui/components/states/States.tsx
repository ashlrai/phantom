/**
 * components/states/States.tsx — the one empty state and the one error state
 * every page uses, built on the EmptyState primitive. An error always names
 * what failed and the exact command that diagnoses or fixes it; an empty state
 * always names the next action.
 */
import type { ReactNode } from 'react';
import { EmptyState as Primitive } from '../primitives/EmptyState.js';

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return <Primitive title={title} body={body} action={action} />;
}

export function ErrorState({ what, error, fix }: { what: string; error?: unknown; fix: string }) {
  const detail = error instanceof Error ? error.message : error ? String(error) : null;
  return (
    <Primitive
      tone="error"
      title={`${what} could not load.`}
      body={<>{detail ? <>{detail} </> : null}Fix: <code>{fix}</code></>}
    />
  );
}
