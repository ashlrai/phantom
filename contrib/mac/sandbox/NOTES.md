# RQ-SBDENYLSDQ7 — SB-17 SANDBOX-DENY-OSA lane tighten

Draft only — never install from this tree. Masbot applies to the live
`~/.ashlr-runs/bin/` under the dispatchd lock. G1-CODE-PIN applies: verify the
pre-shas below against live before touching anything.

Fix-forward on SANDBOX-DENY-OSA (Security PASS 14:15). Appends to all five lane
profiles, tightening only — nothing is relaxed:

```
; SB-17 RQ-SBDENYLSDQ7 SANDBOX-DENY-OSA (Security PASS 14:15): block app launches at the IPC layer (NSWorkspace, LSOpen, pyobjc/subprocess helpers), not just the /usr/bin/open binary. Deny-only append; emitted LAST in every lane profile.
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
(deny appleevent-send)
```

Blocks the escape paths `deny process-exec` on `/usr/bin/open` /
`/usr/bin/osascript` never reached: `NSWorkspace.shared.open`,
`LSOpenApplication`/`LSOpenURL`, `subprocess.Popen`/`pyobjc` helpers (all of
which are Mach RPCs to `launchservicesd`, not execs), and AppleEvent sends
(`osascript`, `tell application` …) at the `appleevent-send` operation.

## Files

- `sb17-block.sb` — the exact 3 appended lines (sha-pinned in `apply-sb17.sh`).
- `sandbox-deny-osa.diff` — unified diff vs live: five `.sb` hunks + `launch.sh`
  pin-line hunk.
- `apply-sb17.sh` — installer (pre-sha gate → tick wait → atomic append →
  re-pin `LSB_SHA` → post-sha table + `sandbox-exec -f` parse check).
- `test-sb17-osa.sh` — acceptance probes run inside each profile.
- `SHA256SUMS` — deliverable + pre/post profile shas.

## Pre/post sha256

| file | pre | post |
|---|---|---|
| `agent.sb` | `002278b0…b82d1` | `ed8fc729…9003` |
| `claude.sb` | `002278b0…b82d1` | `ed8fc729…9003` |
| `codex-cmp.sb` | `56fe451c…70f2b` | `a007a407…f0d7f7` |
| `codex-personal.sb` | `d3f5658f…3757a` | `e085cf77…01f30a` |
| `codex-local.sb` | `fdb051cd…82f06` | **computed at apply** (printed + pinned into `launch.sh`) |
| `launch.sh` | `32adc419…9cc36` | **computed at apply** (depends on `codex-local.sb` post) |

Pre-shas of the four generated profiles were verified live by Masbot
2026-10-27 (terminals/1336.txt MATCH run) and match rev3 generator output.
`codex-local.sb` has no out-of-sandbox staged copy — every lane profile denies
`file-read* file-write*` on `~/.ashlr-runs`, so its contents cannot be read by
an agent lane. Its pre-sha is the `LSB_SHA` pin `launch.sh` already enforces;
`apply-sb17.sh` verifies that pin before appending, computes the post-sha from
the live file, and writes it into `launch.sh` atomically. Its diff hunk is
anchored on the documented SB-16 tail block (SB-16 says "and codex-local.sb");
if `patch(1)` does not apply that one hunk, `apply-sb17.sh` performs the
identical append anyway — the appended bytes are content-independent.

`launch.sh` edit (one line, hunk shows it): `LSB_SHA=` moves from
`fdb051cd…82f06` to `sha256(post codex-local.sb)`. In the diff that value is
the literal token `SB17_POST_SHA_CODEX_LOCAL`; `apply-sb17.sh` substitutes the
real sha whether `launch.sh` is still pristine (`32adc419…`) or was already
patched to the token form (`422ea9b6…`). Any other `launch.sh` state is drift →
the installer hard-stops (exit 9).

## Install (Masbot)

```
cd contrib/mac/sandbox
sh apply-sb17.sh        # want() gate; exits 9 on any PRECOND FAIL
```

Rollback: every touched file gets a `.bak-sb17-<epoch>` beside it.

## Acceptance

```
bash test-sb17-osa.sh   # from outside any lane
```

Per profile, asserts inside `sandbox-exec -f`:

- BLOCKED: `/usr/bin/open -a Calculator.app` (LSOpen), `python3 -c 'import
  subprocess; …open…'`, `swift` `NSWorkspace.shared.open`, `osascript` AppleEvent
  send to System Events
- PASS: `git --version`, `bun test` (fixture), `cargo test` (fixture),
  `codex --version`, `devin --help`/`--version` dry run

Verdicts: `OPENED`/`ESCAPED` means the op provably ran, `BLOCKED` means provably
refused, `INCONCLUSIVE` means the probe itself errored (also a violation — needs
eyes). Fixtures live under `mktemp -d` (outside the `file-write*` HOME deny);
cargo keeps the real `RUSTUP_HOME`/`CARGO_HOME`. A pre-SB17 profile will
correctly report the deny probes as `ESCAPED` — that is the gap this change
closes. Rehearsing the script against the staged post-profiles with the probe
commands exec'd unsandboxed (inside a dev lane, which already denies `open`
exec + `appleevent-send`) showed exactly this shape: `open`/`osascript`/python
blocked, **`NSWorkspace.shared.open` ESCAPED in every profile** — the direct
launchservicesd RPC is unaffected by exec denies, which is what this SB-17
mach-lookup deny is for — and `git`/`bun`/`cargo`/`codex`/`devin` all ok.
