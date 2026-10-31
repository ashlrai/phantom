export const supplyFixture = () => ({
  lanes: [
    { lane: 'held', running: 0, target: 8, queued: 0, held: true, heldReason: 'Quota exhausted' },
    { lane: 'over', running: 5, target: 3, queued: 0, held: false, heldReason: null },
    { lane: 'active', running: 3, target: 8, queued: 1, held: false, heldReason: null },
  ],
  workers: [
    { lane: 'active', ageSeconds: 1200 }, { lane: 'active', ageSeconds: 0 }, { lane: 'active', ageSeconds: null },
    { lane: 'over', ageSeconds: 900 }, { lane: 'held', ageSeconds: 1000 },
  ],
  drop: { pending: [{ lane: 'active', file: 'one.json' }, { lane: 'active', file: 'two.json' }], done: 0 },
  sources: { runsDir: 'healthy' }, claudeLane: 'Claude lane down for maintenance',
});
