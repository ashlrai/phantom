# RQ-DRAIN-PHX-REB-01 outcomes

All six PRs were open and matched their supplied heads when inspected on 2026-11-24. Master used for merge-tree analysis: `11a917d5c872c86a2acd15f742a1f24efc2b4723`.

| PR | Action | New head SHA | Hosted check status at unchanged head | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [8564](https://github.com/ashlrai/phantom/pull/8564) | blocked | none; unchanged `0c6d0d4069e74411737b72ad0ffa0cd0c83a7c17` | Merge Gate and Fast gate success; merge conflicts | n/a |
| [8544](https://github.com/ashlrai/phantom/pull/8544) | blocked | none; unchanged `a3d7c3469e4e50387b7ced6c82169ba692e169bf` | Merge Gate and Fast gate failure; merge conflicts | n/a |
| [8491](https://github.com/ashlrai/phantom/pull/8491) | blocked | none; unchanged `787e7dd47e0768516e8e10b4c8affad368f4ba48` | Merge Gate and Fast gate success; merge conflicts | n/a |
| [8376](https://github.com/ashlrai/phantom/pull/8376) | blocked | none; unchanged `bd9fccf1ce616f8876dddbd15f3afe133779ba6a` | Merge Gate and Fast gate success; merge conflicts | n/a |
| [8319](https://github.com/ashlrai/phantom/pull/8319) | blocked | none; unchanged `787834a312e47348910e744bb27f2dcbe1227859` | Merge Gate and Fast gate failure; merge conflicts | n/a |
| [8316](https://github.com/ashlrai/phantom/pull/8316) | blocked | none; unchanged `ec300acd1fef8fbcd6188fbd2f62fd175dc963d9` | Merge Gate, Fast gate and Quick typecheck failure; merge conflicts | n/a |

Secret-shape scan, Secret scan (diff), generated-files and authority-drift checks succeeded at all six inspected heads. No check-run named exactly `secret-shape` or `clean-tree` appeared in these responses; no required-check configuration was read or changed. The separate Vercel commit status failed on all six; this is not a Merge Gate verdict.

The final task instruction forbids commits, pushes, tags and publishing. No merge commit, push, auto-merge update, closure or PR comment was performed. The GitHub CLI could not read its protected configuration; connected tools available here provide GitHub reads only. Blocker comments could not be posted through those tools. All six remain open.

Supersession is not fully established. Merged [8569](https://github.com/ashlrai/phantom/pull/8569) replaces desktop-error recurrence with different IDs and validation. Open [8415](https://github.com/ashlrai/phantom/pull/8415) recovers the worker-session slice of 8376, including identical session-test blobs. Open [8409](https://github.com/ashlrai/phantom/pull/8409) explicitly covers only the skill-revert slice of 8316. None justifies claiming complete preservation of every change without further accounting. Conflict details are in notes.md.

The requested external handoff directory could not be created: OS permission denied. This worktree-local RESULT.md is the fallback. No credentials were read or copied to work around access restrictions.
