/** Synthetic held-out decisions, separate from candidate construction. */
export const routingTasks = [
  { id: 'docs-change', input: { category: 'docs', expected: 'local' } },
  { id: 'auth-review', input: { category: 'security', expected: 'frontier' } },
  { id: 'bug-fix', input: { category: 'bug', expected: 'frontier' } },
] as const;
