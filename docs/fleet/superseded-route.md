# Fleet superseded route

`GET /api/verse/fleet/runs/superseded` serves the `ashlr fleet superseded`
answer to the Merges pane and the phone. Pinned wire (`SupersededReadV1`):

    { v: 1, generatedAt: string, source: 'ok' | 'unavailable',
      pairs: [{ open, openTitle, openState, mergedBy, mergedTitle, jobId }],
      openDirty: number }

Each `pairs` row names an open PR superseded by merged PR `mergedBy`; `jobId`
is the `RQ-…` id the merged title carries; `openDirty` counts open PRs GitHub
reports DIRTY. The last good read is cached for 60 seconds, and every read is
side-effect free: it never mutates git, GitHub or disk.
