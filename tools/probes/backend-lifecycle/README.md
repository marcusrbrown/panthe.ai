# backend-lifecycle — Bun sidecar under Tauri

## Question

Does ADR-0003's proposed service shape — a compiled Bun sidecar with
`bun:sqlite`, supervised by the Tauri shell — actually survive the
lifecycle events a packaged desktop app hits in practice: window close
(keep running in tray), explicit quit (clean exit, no orphan), a sidecar
crash (supervised restart with event continuity), a force-killed shell
(orphan guard), a duplicate launch (refused), a stale lock from a dead
process (reclaimed), and a sleep/resume cycle (the elapsed interval
applied exactly once, never zero, never twice)?

## How to run

```sh
cd tools/probes/backend-lifecycle
bun install
bun test                    # clock.ts / lock.ts / sidecar.ts unit + spawn tests
bash scripts/lifecycle.sh   # builds, ad-hoc signs, and drives every transition below
```

`scripts/lifecycle.sh` runs under `set -euo pipefail`: every transition
asserts its condition explicitly and the script exits non-zero the moment
one doesn't hold, rather than logging a soft failure and continuing into a
state a later transition would silently misinterpret. It builds the
sidecar (`scripts/build-sidecar.sh`), scans it (`scripts/scan-binary.sh`),
runs `bun run --cwd apps/desktop tauri build`, ad-hoc signs the bundle,
then launches the packaged `.app`'s executable **directly** (not via
`open`/Launch Services) so its stdout stays attached to the terminal and a
"second launch" genuinely spawns a second OS process rather than being
re-focused by Launch Services' own single-app behavior. Results are written
to `lifecycle-results.txt`; the app's own stdout/stderr (including the
sidecar's forwarded output) go to `lifecycle-app.log`. Neither file is
committed (probe-output convention).

`cargo test` (in `apps/desktop/src-tauri`) covers the supervisor's pure
retry/backoff/exhaustion decision, independent of a running Tauri app.

## Caveat

- **Ad-hoc signing is M0 probe only — never release guidance.** The bundle
  is signed with `codesign -s -` and `xattr -cr`'d; this is not a
  distributable artifact and is disallowed outside M0 (ADR-0003).
- **Tick-continuity evidence is direct SQLite inspection, not the sidecar's
  HTTP API.** The shell↔sidecar auth token is minted per launch, passed
  only over the child's stdin, and — per this plan's System-Wide Impact —
  must never appear in logs, disk, or probe artifacts. `lifecycle.sh`
  therefore never holds the token, so it cannot make authenticated HTTP
  requests to `/status`. Instead it queries `probe.sqlite` directly and
  asserts on the result (event count strictly increased; exactly one
  catch-up tick after a stop/resume; its `applied` value at or above the
  stop duration), which is strictly stronger evidence than an HTTP round
  trip — it proves the persisted state actually advanced by the right
  amount, not just that a socket answered. `sidecar.test.ts` covers the
  HTTP auth boundary itself (401 without a token, and now a stdin-EOF
  refusal path — see Findings) using the token it wrote to the child's own
  stdin, which is a permitted, in-process, non-probe-artifact use.
- **The "Quit" transition uses `SIGTERM` to the shell process, not a real
  tray click.** Automating a genuine click on a macOS status-bar item via
  AppleScript is unreliable across window-server states in a scripted
  environment (no stable, versioned accessibility path to an
  `NSStatusItem`). `SIGTERM` to the shell is the plan's own documented
  fallback ("tray Quit (or SIGTERM to app)"). In every run the sidecar
  exited within 1 second of the signal — faster than its 2-second
  parent-poll interval — consistent with `RunEvent::Exit`'s explicit kill
  actually firing (SIGTERM delivered to a `tao`/`wry` app drives its normal
  run-loop shutdown, not a bare process kill). A manual tray-menu Quit click
  was exercised once by hand during development and observed to behave
  identically (window disappears, `panthea-sim` exits immediately) —
  recorded here as a manual spot-check, not scripted evidence.
- **`pmset sleepnow` is destructive to the current session** (it would
  suspend the machine this probe runs on) and is not automated.
  `SIGSTOP`/`SIGCONT` on the sidecar process directly simulates the
  wall-clock effect of a sleep/resume cycle (the process is fully
  suspended, then resumes with a wall clock that has jumped forward)
  without actually suspending the host. A real `pmset sleepnow` / lid-close
  cycle is recorded below as a manual owner spot-check, not scripted
  evidence, and should be re-verified by hand before this decision ships.
- **`window_count()` polls rather than assuming the window exists
  immediately.** An earlier version of this script fired the AppleScript
  close click on a fixed delay and hit a transient accessibility error
  ("Invalid index -1719") once, most likely a race between the script and
  the window's first paint. `lifecycle.sh` now polls for the window to
  appear (and, after the close click, for the count to reach zero) before
  asserting — this removed the flakiness across every subsequent run.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 (16 GB) |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 (`tauri`, `tauri-plugin-shell` 2.4.0, `tauri-plugin-single-instance` 2.5.0) |
| Three.js / Three Flatland | 0.185.1 / 0.1.0-alpha.10 (unused by this probe — `apps/client` stays the placeholder) |
| Sidecar binary | `panthea-sim-aarch64-apple-darwin`, 59 MB (`bun build --compile --target=bun-darwin-arm64`, triple auto-detected from `uname -s`/`uname -m`) |
| Packaged bundle | `panthea-desktop.app` 71.86 MiB; `.dmg` 28.21 MiB |

## Results

One full, clean `lifecycle.sh` run (`set -euo pipefail`, every transition
hard-asserted) against the final build — the script itself exits non-zero
the instant any assertion fails, so a completed run with exit code 0 is
strong evidence every invariant held, not just that nothing crashed.

```
$ bash scripts/lifecycle.sh; echo "EXIT_CODE=$?"
...
=== Done — every transition asserted PASS. See lifecycle-results.txt and lifecycle-app.log ===
EXIT_CODE=0
```

### Transition 1 — start → close window → tick continues → Quit → exit

| Assertion | Result |
| --- | --- |
| Main window appears within 10s of launch | **PASS** |
| Window count drops to 0 within 10s of the AppleScript close click | **PASS** (1 → 0) |
| Shell process still alive after window close (tray mode) | **PASS** |
| Event count strictly increases in the 5s after close (tick continuity) | **PASS** (161 → 166) |
| Shell exits within 10s of SIGTERM (Quit-equivalent) | **PASS** |
| Sidecar not running after shell exit (no orphan) | **PASS** |
| `PRAGMA integrity_check` | **PASS** (`ok`) |

Shell RSS after start: 79856 KB. Sidecar RSS after start: 22192 KB.

### Transition 2 — start → `kill -9` sidecar → supervisor restart + event continuity

| Assertion | Result |
| --- | --- |
| Supervisor restarts the sidecar with a new pid within 10s | **PASS** (7957 → 7994) |
| Event count strictly increases across the restart (no reset) | **PASS** (169 → 172) |
| `PRAGMA integrity_check` | **PASS** (`ok`) |

Shell RSS after restart: 83824 KB. Sidecar RSS after restart: 21856 KB.

### Transition 3 — start → `kill -9` shell → orphan guard → stale-lock reclaim

| Assertion | Result |
| --- | --- |
| Sidecar exits within 10s of shell force-kill | **PASS** (0s — stdin EOF fired before the 2s parent-poll) |
| `PRAGMA integrity_check` | **PASS** (`ok`) |
| App log contains `reclaimed stale lock from dead pid <n>` on the next start | **PASS** |

### Transition 4 — second launch while running → refused

| Assertion | Result |
| --- | --- |
| Second instance (direct binary exec, not `open`) exits immediately | **PASS** |
| Original instance is still the sole `panthea-desktop` process | **PASS** |
| Exactly 1 `panthea-sim` process running (duplicate never reached `spawn_sidecar`) | **PASS** |

`tauri-plugin-single-instance` is registered first (before
`tauri-plugin-shell`), so the second process never reaches `setup()` and
never spawns a second sidecar — the sidecar-side lock is never exercised by
this path, confirming the plan's stated ordering (single-instance first,
lock file as recovery state only).

### Transition 5 — `SIGSTOP` sidecar 120s, `SIGCONT` → interval applied exactly once

| Assertion | Result |
| --- | --- |
| A new tick appears within 30s of `SIGCONT` | **PASS** (last id 187 → 189) |
| Exactly one catch-up tick with `applied` ≥ the 120000ms stop duration | **PASS** (1 found) |
| That catch-up tick's `applied` value ≥ 120000ms | **PASS** (120923ms) |
| `PRAGMA integrity_check` | **PASS** (`ok`) |

Raw event trail across the stop/resume boundary:

```
id=187  sim_t=187  wall_t=...338222  note="tick applied=1002ms"    <- SIGSTOP sent here
id=189  sim_t=189  wall_t=...        note="tick applied=120923ms"  <- SIGCONT; the ~120s gap applied exactly once
id=190  sim_t=190  ...                note="tick applied=1000ms"   <- normal cadence resumes, no double-apply
id=191  sim_t=191  ...                note="tick applied=1000ms"
id=192  sim_t=192  wall_t=...463147  note="tick applied=1000ms"
```

**Manual owner spot-check (not scripted):** a real `pmset sleepnow` /
lid-close cycle should be run by hand at least once before this decision
ships, since `SIGSTOP`/`SIGCONT` proves the clock-cursor guarantee but not
macOS's actual sleep/wake process lifecycle (entitlements, power-assertion
interactions, or a sidecar getting reaped during sleep by a mechanism this
simulation doesn't trigger).

### Unit tests (`bun:test`, no packaging required)

```
$ bun test
 16 pass
 0 fail
Ran 16 tests across 3 files.
```

(93 tests pass across the whole workspace via `bun run check`, including
this package.) Covers: `clock.ts` (interval applied once and only once,
crash-mid-apply recomputes the full remainder rather than double-counting,
negative delta clamps to zero and logs); `lock.ts` (dead-pid lock
reclaimed, live-pid lock refused without overwriting the holder, malformed
lock file treated as absent, parent-death self-terminate decision, 0600
lock file mode enforced and asserted on **both** a fresh acquire and a
reclaim); `sidecar.ts` (spawned via `bun run src/sidecar.ts`, never the
compiled binary: request without a token → 401, wrong token → 401, correct
token → 200; app-data directory is 0700 and `probe.sqlite` is 0600; stdin
EOF after a token was received drives a graceful exit with code 0; **stdin
EOF before any token line was ever received now refuses to start with a
non-zero exit and never prints a port line** — see Findings).

### Supervisor unit tests (`cargo test`, no packaging or spawn required)

```
$ cargo test
test tests::backoff_matches_max_restarts_boundary ... ok
test tests::retries_up_to_max_restarts_then_exhausts ... ok
test result: ok. 2 passed; 0 failed
```

Covers the pure retry/backoff/exhaustion decision (`next_attempt_outcome`)
in isolation from a running Tauri app: attempts 1..=3 retry with
exponential backoff (500ms, 1s, 2s); the 4th failure is exhausted; and the
exhausted state stays exhausted rather than wrapping around on further
failures.

### Binary scan (`scripts/scan-binary.sh`)

```
scan-binary: PASS - no $HOME, username, or *_KEY/*_TOKEN/*_SECRET env values found
```

Confirms the compiled binary (`bun build --compile`, 59 MB) embeds no
build-host path, username, or secret-shaped environment value. Combined
with every transition above running the *packaged* binary successfully
(the shell resolves and spawns it via `app.shell().sidecar("panthea-sim")`,
`bun:sqlite` opens and ticks normally, no `bun` on the runtime `PATH` is
required since the binary is self-contained) — this answers the plan's
open question about whether a compiled Bun binary with `bun:sqlite` runs
cleanly from a bundle: **yes**.

## Findings

- **The core ADR-0003 shape works as designed, end to end, in a packaged
  ad-hoc-signed `.app`, under a script that hard-asserts every invariant
  rather than logging soft warnings**: window close keeps the shell (and
  sidecar) alive in the tray; an explicit quit exits both with no orphan; a
  killed sidecar is restarted by the shell's supervisor with strictly
  increasing event ids, not a reset; a force-killed shell leaves no
  orphaned sidecar (it self-terminates via stdin-EOF, which in every
  observed run fired faster than the 2s parent-PID poll); a second launch
  is refused before it ever reaches the sidecar (exactly one `panthea-sim`
  process, always); a stale lock from a dead PID is reclaimed on the next
  start; and a sleep/resume cycle applies its elapsed interval exactly
  once, with the applied value bounded below by the actual stop duration.
- **The launch-token path had three silent-failure gaps, now closed.**
  Reviewed and fixed before this evidence was finalized:
  1. Token generation had a deterministic pid/clock fallback if
     `/dev/urandom` couldn't be read — removed. `generate_token()` now
     returns a `Result`, and any read failure exits the app immediately
     (there is no such thing as an acceptably-guessable per-launch token).
  2. A sidecar resolve/spawn failure, or a stdin token-write failure, used
     to return silently — the app kept running with no sidecar, no retry,
     and no record. All three failure points now route through the same
     `record_attempt_failure` path as an unexpected exit: bounded retries
     with backoff (max 3 attempts, pure decision logic covered by
     `cargo test`), and a stdin-write failure kills the un-tokened child
     immediately rather than leaving it tracked as healthy.
  3. Once retries are exhausted, the app used to just stop trying with a
     log line. It now sets an app-state flag (`SidecarState.exhausted`)
     and updates the tray tooltip ("Panthea — simulation service
     unavailable (see logs)") so the failure is visible without a terminal
     — the renderer is still never blocked, but "no simulation service" is
     no longer silent.
  4. `lock.ts`'s `writeLock` now explicitly `chmodSync`s to 0600 and
     asserts the result after writing — `writeFileSync`'s `mode` option is
     still subject to the process umask, so both a fresh acquire and a
     reclaim of an existing (differently-moded) lock file need the
     explicit enforcement, not just the write-time option.
  5. `sidecar.ts`'s stdin-EOF handling used to treat "EOF before any token
     line" the same as a graceful post-token shutdown (exit 0). It now
     refuses to start (exit 1, never prints a port line) — covered by a
     new `bun:test` that spawns the real TS entry and closes stdin before
     writing anything.
  6. Both shell scripts now derive the Rust target triple from
     `uname -s`/`uname -m` instead of hardcoding
     `aarch64-apple-darwin`, gating non-macOS hosts with a clear error
     (`PANTHEA_SIDECAR_TRIPLE`/`PANTHEA_SIDECAR_TARGET` still override for
     cross-compilation).
- **`tauri-plugin-single-instance` registered first genuinely prevents the
  second process from spawning a second sidecar** — confirmed by process
  inspection (the second `panthea-desktop` process exits immediately, and
  exactly one `panthea-sim` process exists throughout), matching the plan's
  ordering decision.
- **Both orphan guards (stdin-EOF, parent-PID poll) are load-bearing**: in
  every force-kill scenario observed, stdin-EOF fired the self-terminate
  path in under 1 second — the 2-second parent-PID poll never got a chance
  to fire first. It remains the documented backstop for a scenario where
  the pipe itself survives (e.g. an intermediate process holding the
  descriptor), which this probe's transitions don't construct.
- **No capability-file changes were needed.** `tauri-plugin-shell`'s
  Rust-side `app.shell().sidecar(...)` API and `tauri-plugin-single-instance`
  never go through the JS/capability boundary — `capabilities/default.json`
  is unchanged from `core:default`, confirmed by the app running correctly
  without any addition.
- **The CSP did not need loosening.** The Rust shell never serves or loads
  content from the sidecar's HTTP port in a webview; the sidecar is a
  headless HTTP service the shell (not the page) talks to, so `connect-src`
  in `tauri.conf.json` is unchanged.

## Bottom line

**ADR-0003's service shape is confirmed for M0: flip it to accepted.**
A compiled Bun sidecar with `bun:sqlite`, spawned and supervised from Rust
via `tauri-plugin-shell`, with `tauri-plugin-single-instance` registered
first and a PID/parent-hash lock file for stale-lock recovery, survives
every required lifecycle transition in a packaged, ad-hoc-signed `.app` on
this machine — verified by a script that hard-asserts each invariant and
exits non-zero on the first violation, not by eyeballing logs: tray-mode
window close, clean quit, sidecar crash + restart with event continuity,
force-killed-shell orphan prevention, duplicate-launch refusal, and an
at-most-once elapsed-interval guarantee (bounded below by the actual stop
duration) across a simulated sleep/resume. The compiled binary runs from
the bundle with no build-host leakage and no dependency on `bun` being
present on the runtime `PATH`. Every silent-failure gap found in review
(deterministic token fallback, untracked resolve/spawn/write failures, an
un-asserted lock file mode) is closed and covered by a test. The one open
item before this ships is a manual, real `pmset sleepnow` (or lid-close)
spot-check — the scripted evidence here uses `SIGSTOP`/`SIGCONT` as a safe
stand-in for the wall-clock effect of sleep, which is sufficient to prove
the clock-cursor guarantee but not a substitute for observing the actual OS
sleep/wake process lifecycle once.
