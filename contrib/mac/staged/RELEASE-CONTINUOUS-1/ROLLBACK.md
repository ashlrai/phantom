# Rollback

```sh
patch -R ~/.ashlr-runs/bin/release-autorun.sh < ~/.ashlr-runs/staged/RELEASE-CONTINUOUS-1/release-autorun.diff
rm -f ~/.ashlr-runs/bin/release-verify-installed.mjs
```

`~/.ashlr-runs/metrics/releases.jsonl` is append-only evidence; keep it.
