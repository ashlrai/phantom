---
name: Bug report
about: Report something that isn't working as expected
title: "[Bug]: "
labels: bug, needs-triage
assignees: ''
---

<!-- Security vulnerability? Do not file it here. Use private vulnerability
     reporting as described in SECURITY.md. Before pasting any output below,
     remove secret values, tokens and personal absolute paths. -->

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behavior:

1. Run `...`
2. With config `...`
3. See error

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include any error output.

```
<paste output here>
```

## Fleet / autonomous loop context

If the bug involves the autonomous operator, please fill in:

- **Kill-switch state** (`phm enroll list` — is the kill switch on?): 
- **Engine / model in use** (from `phm doctor` or `~/.ashlr/config.json`; never paste keys): 
- **Relevant log entries** (`phm audit 50`, or the tail of `~/.ashlr/logs/`):

```
<paste relevant log lines here>
```

- **`phm doctor` output**:

```
<paste phm doctor output here>
```

`ashlr` is a compatible alias for `phm`; either name works in the commands above.

## Environment

- Phantom version: <!-- output of `phm --version` -->
- Node.js version: <!-- output of `node --version` -->
- OS: <!-- e.g. macOS 15.5, Ubuntu 24.04 -->
- Install method: <!-- install.sh / npm install -g @ashlr/phantom / source -->

## Additional context

Add any other context about the problem here (logs, screenshots, related commands).
