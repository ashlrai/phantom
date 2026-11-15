# Test changed files

Run `phm test --changed` in a trusted npm repository. It compares the working tree, including untracked files, with `HEAD`. Use `--base <ref>` to compare with another Git ref, and `--json` for a machine-readable selection, reason and exit code. The command runs `npm test` and returns its exit status.

For Vitest scripts, it selects tests reachable through relative literal JavaScript or TypeScript imports and re-exports. If any changed file has no known path to a test, is deleted, or is not a supported module, it runs the full test script. Other runners also run the full script. No changes means no test run.

Import graphs cannot identify tests that read files as text, aliases, computed imports, or dependencies outside the supported extensions. A known import path does not prove those other dependencies are absent; run those tests explicitly and use the full suite for complete coverage. This command is fast feedback, not a replacement for CI.
